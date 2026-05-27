use std::{
  collections::BTreeMap,
  fs,
  io::{Cursor, Read, Seek, SeekFrom, Write},
  path::Path,
};

use lz4_flex::block;
use sha1::{Digest, Sha1};

use crate::{
  application::models::{BundleInfo, BundleManifest, BundleNode, Replacement},
  domain::bundle::serialized,
  support::shared,
};

pub const MANIFEST_NAME: &str = "bundle_manifest.json";
pub const MANIFEST_SCHEMA_VERSION: u32 = 2;

const UNITY_SIGNATURE: &str = "UnityFS";
const BLOCK_INFO_AT_END_FLAG: u32 = 0x80;
const DIRECTORY_AT_END_FLAG: u32 = 0x100;
const COMPRESSION_MASK: u32 = 0x3f;
const MAX_BUNDLE_HEADER_READ: usize = 1024 * 1024;

#[derive(Debug, Clone)]
struct BlockInfo {
  uncompressed_size: u32,
  compressed_size: u32,
  flags: u16,
}

#[derive(Debug, Clone)]
struct ParsedBundle {
  info: BundleInfo,
  header: Vec<u8>,
  blocks: Vec<BlockInfo>,
  nodes: Vec<BundleNode>,
  payload: Vec<u8>,
}

pub fn analyze(bundle_path: &Path) -> Result<BundleInfo, String> {
  Ok(parse(bundle_path, false)?.info)
}

pub fn extract(bundle_path: &Path, out_dir: &Path, force: bool) -> Result<BundleManifest, String> {
  let parsed = parse(bundle_path, true)?;
  if let Ok(stat) = fs::metadata(out_dir) {
    if !stat.is_dir() {
      return Err(format!("Bundle 工作区不是目录: {}", out_dir.display()));
    }
    if force {
      fs::remove_dir_all(out_dir).map_err(|err| err.to_string())?;
    } else if !shared::dir_is_empty(out_dir)? {
      return Err(format!("Bundle 工作区非空: {}", out_dir.display()));
    }
  }

  let files_dir = out_dir.join("files");
  let resources_dir = out_dir.join("resources");
  fs::create_dir_all(&files_dir).map_err(|err| err.to_string())?;
  fs::create_dir_all(&resources_dir).map_err(|err| err.to_string())?;

  let mut nodes = parsed.nodes.clone();
  let source_nodes = parsed.nodes.clone();
  let mut resources = Vec::new();

  for node in &mut nodes {
    let start = usize::try_from(node.offset).map_err(|_| format!("Bundle 节点偏移非法: {}", node.path))?;
    let size = usize::try_from(node.size).map_err(|_| format!("Bundle 节点大小非法: {}", node.path))?;
    let end = start.checked_add(size).ok_or_else(|| format!("Bundle 节点范围非法: {}", node.path))?;
    if end > parsed.payload.len() {
      return Err(format!("Bundle 节点范围非法: {}", node.path));
    }

    let payload = &parsed.payload[start..end];
    node.file_name = safe_node_file_name_from_path(&node.path, node.id.as_str());
    node.kind = classify_node(&node.path).to_string();
    node.crc = Some(crc_hex(payload));

    let dest = files_dir.join(&node.file_name);
    fs::write(&dest, payload).map_err(|err| err.to_string())?;

    let mut node_resources = serialized::extract_serialized_resources(node, payload);
    for resource in &mut node_resources {
      let exported = serialized::export_resource(resource, payload, &source_nodes, &parsed.payload).unwrap_or_else(|_| {
        let fallback = serialized::resource_payload(resource, payload);
        let data = if fallback.is_empty() {
          format!(
            "name: {}\ntype: {}\nclass_id: {}\npath_id: {}\n",
            resource.name, resource.r#type, resource.class_id, resource.path_id
          )
          .into_bytes()
        } else {
          fallback
        };
        serialized::ResourceExport {
          bytes: data,
          file_name: resource.file_name.clone(),
          details: resource.details.clone(),
        }
      });
      let data = exported.bytes;
      resource.file_name = exported.file_name;
      if exported.details.is_some() {
        resource.details = exported.details;
      }
      resource.size = data.len() as i64;
      resource.crc = Some(crc_hex(&data));
      fs::write(resources_dir.join(&resource.file_name), &data).map_err(|err| err.to_string())?;
      resources.push(resource.clone());
    }
  }

  let mut info = parsed.info.clone();
  info.resource_count = resources.len();
  let manifest = BundleManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    tool: "apkworkshop-tauri".to_string(),
    source_bundle: shared::must_abs(bundle_path),
    extracted_at: shared::now_rfc3339(),
    info,
    nodes,
    resources,
    replacements: Vec::new(),
  };
  write_manifest(out_dir, &manifest)?;
  Ok(manifest)
}

pub fn load_manifest(work_dir: &Path) -> Result<BundleManifest, String> {
  let manifest: BundleManifest = shared::read_json_file(&work_dir.join(MANIFEST_NAME))?;
  let mut manifest = if manifest_needs_refresh(work_dir, &manifest) {
    refresh_manifest(work_dir, manifest)?
  } else {
    manifest
  };
  normalize_manifest(&mut manifest);
  Ok(manifest)
}

fn normalize_manifest(manifest: &mut BundleManifest) {
  let mut changed_nodes = BTreeMap::new();
  let mut changed_resources = BTreeMap::new();
  for item in &manifest.replacements {
    if let Some(node_id) = &item.node_id {
      changed_nodes.insert(node_id.clone(), true);
    }
    if let Some(resource_id) = &item.resource_id {
      changed_resources.insert(resource_id.clone(), true);
    }
  }
  for node in &mut manifest.nodes {
    node.changed = changed_nodes.get(&node.id).copied().unwrap_or(false);
    if node.file_name.is_empty() {
      node.file_name = safe_node_file_name_from_path(&node.path, node.id.as_str());
    }
    if node.kind.is_empty() {
      node.kind = classify_node(&node.path).to_string();
    }
  }
  for resource in &mut manifest.resources {
    resource.changed = changed_resources.get(&resource.id).copied().unwrap_or(false);
  }
  manifest.info.resource_count = manifest.resources.len();
}

fn manifest_needs_refresh(work_dir: &Path, manifest: &BundleManifest) -> bool {
  if manifest.schema_version < MANIFEST_SCHEMA_VERSION {
    return true;
  }
  let files_dir = work_dir.join("files");
  let resources_dir = work_dir.join("resources");
  if !files_dir.is_dir() || !resources_dir.is_dir() {
    return true;
  }
  manifest.nodes.iter().any(|node| !files_dir.join(&node.file_name).is_file())
    || manifest.resources.iter().any(|resource| {
      let path = resources_dir.join(&resource.file_name);
      !path.is_file() || stale_resource_export(resource)
    })
}

fn stale_resource_export(resource: &crate::application::models::BundleResource) -> bool {
  match resource.class_id {
    28 => !resource.file_name.to_ascii_lowercase().ends_with(".png"),
    83 => !matches!(
      Path::new(&resource.file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str(),
      "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac"
    ),
    _ => false,
  }
}

fn refresh_manifest(work_dir: &Path, mut manifest: BundleManifest) -> Result<BundleManifest, String> {
  let files_dir = work_dir.join("files");
  if !files_dir.is_dir() {
    return Err(format!("Bundle 节点目录不存在: {}", files_dir.display()));
  }

  let resources_dir = work_dir.join("resources");
  if resources_dir.exists() {
    fs::remove_dir_all(&resources_dir).map_err(|err| err.to_string())?;
  }
  fs::create_dir_all(&resources_dir).map_err(|err| err.to_string())?;

  let mut ordered = manifest.nodes.clone();
  ordered.sort_by_key(|node| node.offset);

  let mut payload = Vec::new();
  for node in &mut ordered {
    if node.file_name.is_empty() {
      node.file_name = safe_node_file_name_from_path(&node.path, node.id.as_str());
    }
    if node.kind.is_empty() {
      node.kind = classify_node(&node.path).to_string();
    }
    let data = fs::read(files_dir.join(&node.file_name)).map_err(|_| format!("Bundle 节点文件缺失: {}", node.path))?;
    node.offset = payload.len() as i64;
    node.size = data.len() as i64;
    node.crc = Some(crc_hex(&data));
    payload.extend_from_slice(&data);
  }

  let ordered_map = ordered
    .iter()
    .cloned()
    .map(|node| (node.id.clone(), node))
    .collect::<BTreeMap<_, _>>();
  for node in &mut manifest.nodes {
    if let Some(updated) = ordered_map.get(&node.id) {
      node.offset = updated.offset;
      node.size = updated.size;
      node.crc = updated.crc.clone();
      node.file_name = updated.file_name.clone();
      node.kind = updated.kind.clone();
    }
  }
  manifest.info.nodes = manifest.nodes.clone();

  let source_nodes = manifest.nodes.clone();
  let mut resources = Vec::new();
  for node in &source_nodes {
    let node_path = files_dir.join(&node.file_name);
    let node_bytes = fs::read(&node_path).map_err(|_| format!("Bundle 节点文件缺失: {}", node.path))?;
    let mut node_resources = serialized::extract_serialized_resources(node, &node_bytes);
    for resource in &mut node_resources {
      let exported = serialized::export_resource(resource, &node_bytes, &source_nodes, &payload).unwrap_or_else(|_| {
        let fallback = serialized::resource_payload(resource, &node_bytes);
        let data = if fallback.is_empty() {
          format!(
            "name: {}\ntype: {}\nclass_id: {}\npath_id: {}\n",
            resource.name, resource.r#type, resource.class_id, resource.path_id
          )
          .into_bytes()
        } else {
          fallback
        };
        serialized::ResourceExport {
          bytes: data,
          file_name: resource.file_name.clone(),
          details: resource.details.clone(),
        }
      });
      resource.file_name = exported.file_name;
      if exported.details.is_some() {
        resource.details = exported.details;
      }
      resource.size = exported.bytes.len() as i64;
      resource.crc = Some(crc_hex(&exported.bytes));
      fs::write(resources_dir.join(&resource.file_name), &exported.bytes).map_err(|err| err.to_string())?;
      resources.push(resource.clone());
    }
  }

  resources.sort_by(|left, right| match left.kind.cmp(&right.kind) {
    std::cmp::Ordering::Equal => left.name.cmp(&right.name),
    other => other,
  });

  manifest.schema_version = MANIFEST_SCHEMA_VERSION;
  manifest.tool = "apkworkshop-tauri".to_string();
  manifest.info.node_count = manifest.nodes.len();
  manifest.info.resource_count = resources.len();
  manifest.info.nodes = manifest.nodes.clone();
  manifest.resources = resources;
  shared::write_json_file(&work_dir.join(MANIFEST_NAME), &manifest)?;
  Ok(manifest)
}

pub fn write_manifest(work_dir: &Path, manifest: &BundleManifest) -> Result<(), String> {
  shared::write_json_file(&work_dir.join(MANIFEST_NAME), manifest)
}

pub fn replace_node(work_dir: &Path, node_id: &str, source_path: &Path) -> Result<(Replacement, BundleManifest), String> {
  let mut manifest = load_manifest(work_dir)?;
  let index = manifest
    .nodes
    .iter()
    .position(|node| node.id == node_id)
    .ok_or_else(|| format!("Bundle 节点不存在: {node_id}"))?;
  let stat = fs::metadata(source_path).map_err(|_| format!("替换文件不可用: {}", source_path.display()))?;
  if stat.is_dir() {
    return Err(format!("替换文件不可用: {}", source_path.display()));
  }
  let dest = work_dir.join("files").join(&manifest.nodes[index].file_name);
  shared::copy_file(source_path, &dest)?;
  let (size, crc) = shared::file_crc(&dest)?;
  manifest.nodes[index].changed = true;
  manifest.nodes[index].size = size as i64;
  manifest.nodes[index].crc = Some(crc.clone());

  let record = Replacement {
    kind: Some("bundle-node".to_string()),
    path: manifest.source_bundle.clone(),
    source_path: shared::must_abs(source_path),
    size,
    crc,
    replaced_at: shared::now_rfc3339(),
    node_id: Some(node_id.to_string()),
    node_path: Some(manifest.nodes[index].path.clone()),
    resource_id: None,
  };
  manifest.replacements.push(record.clone());
  write_manifest(work_dir, &manifest)?;
  Ok((record, manifest))
}

pub fn replace_resource(work_dir: &Path, resource_id: &str, source_path: &Path) -> Result<(Replacement, BundleManifest), String> {
  let mut manifest = load_manifest(work_dir)?;
  let resource_index = manifest
    .resources
    .iter()
    .position(|resource| resource.id == resource_id)
    .ok_or_else(|| format!("Bundle 资源不存在: {resource_id}"))?;

  if !manifest.resources[resource_index].replaceable {
    return Err(format!(
      "该资源暂不支持内容替换: {}",
      manifest.resources[resource_index].r#type
    ));
  }
  let replacement = fs::read(source_path).map_err(|_| format!("替换文件不可用: {}", source_path.display()))?;
  let node_index = manifest
    .nodes
    .iter()
    .position(|node| node.id == manifest.resources[resource_index].node_id)
    .ok_or_else(|| format!("资源所在节点不存在: {}", manifest.resources[resource_index].node_id))?;

  let node_path = work_dir.join("files").join(&manifest.nodes[node_index].file_name);
  let node_data = fs::read(&node_path).map_err(|err| err.to_string())?;
  let next_node_data = serialized::replace_serialized_resource(&node_data, &manifest.resources[resource_index], &replacement)?;
  fs::write(&node_path, &next_node_data).map_err(|err| err.to_string())?;

  let resource_path = work_dir.join("resources").join(&manifest.resources[resource_index].file_name);
  fs::write(&resource_path, &replacement).map_err(|err| err.to_string())?;
  let (size, crc) = shared::file_crc(&resource_path)?;

  manifest.resources[resource_index].changed = true;
  manifest.resources[resource_index].size = size as i64;
  manifest.resources[resource_index].crc = Some(crc.clone());
  manifest.nodes[node_index].changed = true;
  manifest.nodes[node_index].size = next_node_data.len() as i64;
  manifest.nodes[node_index].crc = Some(crc_hex(&next_node_data));

  let record = Replacement {
    kind: Some("bundle-resource".to_string()),
    path: manifest.source_bundle.clone(),
    source_path: shared::must_abs(source_path),
    size,
    crc,
    replaced_at: shared::now_rfc3339(),
    node_id: Some(manifest.resources[resource_index].node_id.clone()),
    node_path: Some(manifest.resources[resource_index].node_path.clone()),
    resource_id: Some(manifest.resources[resource_index].id.clone()),
  };
  manifest.replacements.push(record.clone());
  write_manifest(work_dir, &manifest)?;
  Ok((record, manifest))
}

pub fn build(work_dir: &Path, output_bundle_path: &Path) -> Result<(), String> {
  let manifest = load_manifest(work_dir)?;
  if manifest.nodes.is_empty() {
    return Err("Bundle 清单没有节点".to_string());
  }

  let mut nodes = manifest.nodes.clone();
  let mut payload = Vec::new();
  for node in &mut nodes {
    let source = work_dir.join("files").join(&node.file_name);
    let data = fs::read(&source).map_err(|_| format!("Bundle 节点文件缺失: {}", node.path))?;
    node.offset = payload.len() as i64;
    node.size = data.len() as i64;
    node.crc = Some(crc_hex(&data));
    payload.extend_from_slice(&data);
  }

  let compression = manifest.info.compression.clone();
  if compression == "lzma" {
    return Err("不支持重封 LZMA Bundle".to_string());
  }

  let compressed_payload = compress_block(&payload, &compression)?;
  let block = BlockInfo {
    uncompressed_size: payload.len() as u32,
    compressed_size: compressed_payload.len() as u32,
    flags: compression_flag(&compression),
  };
  let blocks_info = encode_blocks_info(&[block.clone()], &nodes)?;
  let compressed_blocks_info = compress_block(&blocks_info, &compression)?;

  let mut info = manifest.info.clone();
  info.compressed_size = compressed_blocks_info.len() as u32;
  info.uncompressed_size = blocks_info.len() as u32;
  info.flags = (info.flags & !COMPRESSION_MASK) | compression_flag(&compression) as u32;
  info.flags &= !(BLOCK_INFO_AT_END_FLAG | DIRECTORY_AT_END_FLAG);
  info.blocks_info_at_end = false;
  info.directory_at_end = false;
  info.block_count = 1;
  info.node_count = nodes.len();
  info.total_size = (header_size(&info) + compressed_blocks_info.len() + compressed_payload.len()) as u64;

  if let Some(parent) = output_bundle_path.parent() {
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  let tmp = output_bundle_path.with_extension("bundle.tmp");
  let mut out = fs::File::create(&tmp).map_err(|err| err.to_string())?;
  write_header(&mut out, &info)?;
  out.write_all(&compressed_blocks_info).map_err(|err| err.to_string())?;
  out.write_all(&compressed_payload).map_err(|err| err.to_string())?;
  drop(out);
  fs::rename(tmp, output_bundle_path).map_err(|err| err.to_string())
}

fn parse(bundle_path: &Path, with_payload: bool) -> Result<ParsedBundle, String> {
  let data = fs::read(bundle_path).map_err(|err| err.to_string())?;
  let mut reader = Cursor::new(&data);
  let (mut info, header) = read_header(&mut reader)?;
  info.source_path = shared::must_abs(bundle_path);

  if info.signature != UNITY_SIGNATURE {
    return Err(format!("不支持的 Bundle 格式: {}", info.signature));
  }
  if info.format_version != 6 && info.format_version != 7 {
    return Err(format!("不支持的 UnityFS 版本: {}", info.format_version));
  }
  if info.directory_at_end {
    return Err("暂不支持目录信息位于文件末尾的 Bundle".to_string());
  }
  if info.compression == "lzma" {
    return Err("暂不支持 LZMA Bundle".to_string());
  }

  let compressed_blocks_info = if info.blocks_info_at_end {
    let start = data
      .len()
      .checked_sub(info.compressed_size as usize)
      .ok_or_else(|| "Bundle blocks info 范围非法".to_string())?;
    data[start..].to_vec()
  } else {
    let mut buf = vec![0_u8; info.compressed_size as usize];
    reader.read_exact(&mut buf).map_err(|err| err.to_string())?;
    buf
  };

  let blocks_info = decompress_block(&compressed_blocks_info, info.uncompressed_size, &info.compression)?;
  let (blocks, nodes) = decode_blocks_info(&blocks_info)?;
  info.block_count = blocks.len();
  info.node_count = nodes.len();

  let mut parsed = ParsedBundle {
    info,
    header,
    blocks,
    nodes,
    payload: Vec::new(),
  };
  if !with_payload {
    return Ok(parsed);
  }

  let raw_payload = if parsed.info.blocks_info_at_end {
    let start = parsed.header.len();
    let end = data
      .len()
      .checked_sub(parsed.info.compressed_size as usize)
      .ok_or_else(|| "Bundle payload 范围非法".to_string())?;
    if end < start {
      return Err("Bundle payload 范围非法".to_string());
    }
    data[start..end].to_vec()
  } else {
    let mut rest = Vec::new();
    reader.read_to_end(&mut rest).map_err(|err| err.to_string())?;
    rest
  };

  let mut payload = Vec::new();
  let mut offset = 0_usize;
  for block in &parsed.blocks {
    let end = offset
      .checked_add(block.compressed_size as usize)
      .ok_or_else(|| "Bundle block 超出 payload 范围".to_string())?;
    if end > raw_payload.len() {
      return Err("Bundle block 超出 payload 范围".to_string());
    }
    let chunk = decompress_block(&raw_payload[offset..end], block.uncompressed_size, compression_from_flags(block.flags as u32))?;
    payload.extend_from_slice(&chunk);
    offset = end;
  }

  parsed.info.uncompressed_bytes = payload.len() as i64;
  parsed.payload = payload;
  parsed.nodes = parsed.nodes.clone();
  parsed.info.nodes = parsed.nodes.clone();
  Ok(parsed)
}

fn read_header(reader: &mut Cursor<&Vec<u8>>) -> Result<(BundleInfo, Vec<u8>), String> {
  let start_pos = reader.position() as usize;
  let signature = read_c_string(reader)?;
  let version = read_u32(reader)?;
  let player_version = read_c_string(reader)?;
  let engine_version = read_c_string(reader)?;
  let total_size = read_u64(reader)?;
  let compressed_size = read_u32(reader)?;
  let uncompressed_size = read_u32(reader)?;
  let flags = read_u32(reader)?;

  if version >= 7 {
    let consumed = reader.position() as usize - start_pos;
    let padding = align_padding(consumed, 16);
    if padding > 0 {
      reader.seek(SeekFrom::Current(padding as i64)).map_err(|err| err.to_string())?;
    }
  }

  let header_size = reader.position() as usize - start_pos;
  if header_size == 0 || header_size > MAX_BUNDLE_HEADER_READ {
    return Err("Bundle header 大小异常".to_string());
  }
  let header = reader.get_ref()[start_pos..start_pos + header_size].to_vec();

  let info = BundleInfo {
    source_path: String::new(),
    signature,
    format_version: version,
    player_version,
    engine_version,
    total_size,
    compressed_size,
    uncompressed_size,
    flags,
    compression: compression_from_flags(flags).to_string(),
    blocks_info_at_end: flags & BLOCK_INFO_AT_END_FLAG != 0,
    directory_at_end: flags & DIRECTORY_AT_END_FLAG != 0,
    block_count: 0,
    node_count: 0,
    resource_count: 0,
    nodes: Vec::new(),
    uncompressed_bytes: 0,
  };
  Ok((info, header))
}

fn decode_blocks_info(data: &[u8]) -> Result<(Vec<BlockInfo>, Vec<BundleNode>), String> {
  let mut reader = Cursor::new(data);
  if data.len() < 16 {
    return Err("blocks info 太短".to_string());
  }
  let mut hash = [0_u8; 16];
  reader.read_exact(&mut hash).map_err(|err| err.to_string())?;

  let block_count = read_i32(&mut reader)?;
  if !(0..=100_000).contains(&block_count) {
    return Err(format!("block 数量异常: {block_count}"));
  }
  let mut blocks = Vec::with_capacity(block_count as usize);
  for _ in 0..block_count {
    blocks.push(BlockInfo {
      uncompressed_size: read_u32(&mut reader)?,
      compressed_size: read_u32(&mut reader)?,
      flags: read_u16(&mut reader)?,
    });
  }

  let node_count = read_i32(&mut reader)?;
  if !(0..=100_000).contains(&node_count) {
    return Err(format!("节点数量异常: {node_count}"));
  }
  let mut nodes = Vec::with_capacity(node_count as usize);
  for index in 0..node_count {
    let offset = read_i64(&mut reader)?;
    let size = read_i64(&mut reader)?;
    let flags = read_u32(&mut reader)?;
    let path = read_c_string(&mut reader)?;
    let id = node_id(index as usize, &path);
    nodes.push(BundleNode {
      id: id.clone(),
      path: path.clone(),
      name: Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&path)
        .to_string(),
      offset,
      size,
      flags,
      crc: None,
      changed: false,
      file_name: safe_node_file_name_from_path(&path, &id),
      kind: classify_node(&path).to_string(),
    });
  }
  Ok((blocks, nodes))
}

fn encode_blocks_info(blocks: &[BlockInfo], nodes: &[BundleNode]) -> Result<Vec<u8>, String> {
  let mut out = Vec::new();
  out.extend_from_slice(&[0_u8; 16]);
  write_i32(&mut out, blocks.len() as i32)?;
  for block in blocks {
    write_u32(&mut out, block.uncompressed_size)?;
    write_u32(&mut out, block.compressed_size)?;
    write_u16(&mut out, block.flags)?;
  }
  write_i32(&mut out, nodes.len() as i32)?;

  let mut sorted = nodes.to_vec();
  sorted.sort_by_key(|node| node.offset);
  for node in &sorted {
    write_i64(&mut out, node.offset)?;
    write_i64(&mut out, node.size)?;
    write_u32(&mut out, node.flags)?;
    write_c_string(&mut out, &node.path)?;
  }
  Ok(out)
}

fn write_header(writer: &mut dyn Write, info: &BundleInfo) -> Result<(), String> {
  let mut out = Vec::new();
  write_c_string(&mut out, UNITY_SIGNATURE)?;
  write_u32(&mut out, info.format_version)?;
  write_c_string(&mut out, &info.player_version)?;
  write_c_string(&mut out, &info.engine_version)?;
  write_u64(&mut out, info.total_size)?;
  write_u32(&mut out, info.compressed_size)?;
  write_u32(&mut out, info.uncompressed_size)?;
  write_u32(&mut out, info.flags)?;
  if info.format_version >= 7 {
    let padding = align_padding(out.len(), 16);
    if padding > 0 {
      out.resize(out.len() + padding, 0);
    }
  }
  writer.write_all(&out).map_err(|err| err.to_string())
}

fn header_size(info: &BundleInfo) -> usize {
  let mut size = UNITY_SIGNATURE.len() + 1 + 4 + info.player_version.len() + 1 + info.engine_version.len() + 1 + 8 + 4 + 4 + 4;
  if info.format_version >= 7 {
    size += align_padding(size, 16);
  }
  size
}

fn decompress_block(src: &[u8], size: u32, compression: &str) -> Result<Vec<u8>, String> {
  match compression {
    "none" => {
      if src.len() != size as usize {
        return Err(format!("未压缩块大小不匹配: {} != {size}", src.len()));
      }
      Ok(src.to_vec())
    }
    "lz4" | "lz4hc" => block::decompress(src, size as usize).map_err(|err| err.to_string()),
    "lzma" => Err("暂不支持 LZMA".to_string()),
    other => Err(format!("未知压缩方式: {other}")),
  }
}

fn compress_block(src: &[u8], compression: &str) -> Result<Vec<u8>, String> {
  match compression {
    "none" => Ok(src.to_vec()),
    "lz4" | "lz4hc" => Ok(block::compress(src)),
    "lzma" => Err("暂不支持 LZMA".to_string()),
    other => Err(format!("未知压缩方式: {other}")),
  }
}

fn compression_from_flags(flags: u32) -> &'static str {
  match flags & COMPRESSION_MASK {
    0 => "none",
    1 => "lzma",
    2 => "lz4",
    3 => "lz4hc",
    _ => "unknown",
  }
}

fn compression_flag(kind: &str) -> u16 {
  match kind {
    "none" => 0,
    "lzma" => 1,
    "lz4" => 2,
    "lz4hc" => 3,
    _ => 0,
  }
}

fn classify_node(path: &str) -> &'static str {
  match Path::new(path)
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or_default()
    .to_ascii_lowercase()
    .as_str()
  {
    "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => "image",
    "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac" => "audio",
    "json" | "xml" | "txt" | "lua" | "properties" | "cfg" | "ini" | "md" | "shader" => "text",
    _ => "binary",
  }
}

fn node_id(index: usize, path: &str) -> String {
  let mut hasher = Sha1::new();
  hasher.update(format!("{index}:{path}").as_bytes());
  let digest = hasher.finalize();
  digest[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

fn safe_node_file_name_from_path(path: &str, id: &str) -> String {
  let name = Path::new(path)
    .file_name()
    .and_then(|value| value.to_str())
    .filter(|value| !value.is_empty())
    .unwrap_or("node");
  format!("{}_{}", &id[..id.len().min(8)], sanitize_filename(name))
}

fn replace_ext_or_suffix(file_name: &str, suffix: &str) -> String {
  match file_name.rfind('.') {
    Some(index) => format!("{}{}", &file_name[..index], suffix),
    None => format!("{file_name}{suffix}"),
  }
}

fn sanitize_filename(value: &str) -> String {
  value
    .chars()
    .map(|ch| match ch {
      '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
      other => other,
    })
    .collect()
}

fn crc_hex(data: &[u8]) -> String {
  format!("{:08x}", crc32fast::hash(data))
}

fn align_padding(size: usize, align: usize) -> usize {
  if align == 0 {
    return 0;
  }
  let remainder = size % align;
  if remainder == 0 {
    0
  } else {
    align - remainder
  }
}

fn read_c_string(reader: &mut dyn Read) -> Result<String, String> {
  let mut out = Vec::new();
  let mut byte = [0_u8; 1];
  loop {
    reader.read_exact(&mut byte).map_err(|err| err.to_string())?;
    if byte[0] == 0 {
      return String::from_utf8(out).map_err(|err| err.to_string());
    }
    out.push(byte[0]);
    if out.len() > MAX_BUNDLE_HEADER_READ {
      return Err("字符串字段过长".to_string());
    }
  }
}

fn write_c_string(writer: &mut dyn Write, value: &str) -> Result<(), String> {
  writer.write_all(value.as_bytes()).map_err(|err| err.to_string())?;
  writer.write_all(&[0]).map_err(|err| err.to_string())
}

fn read_u16(reader: &mut dyn Read) -> Result<u16, String> {
  let mut buf = [0_u8; 2];
  reader.read_exact(&mut buf).map_err(|err| err.to_string())?;
  Ok(u16::from_be_bytes(buf))
}

fn read_u32(reader: &mut dyn Read) -> Result<u32, String> {
  let mut buf = [0_u8; 4];
  reader.read_exact(&mut buf).map_err(|err| err.to_string())?;
  Ok(u32::from_be_bytes(buf))
}

fn read_u64(reader: &mut dyn Read) -> Result<u64, String> {
  let mut buf = [0_u8; 8];
  reader.read_exact(&mut buf).map_err(|err| err.to_string())?;
  Ok(u64::from_be_bytes(buf))
}

fn read_i32(reader: &mut dyn Read) -> Result<i32, String> {
  let mut buf = [0_u8; 4];
  reader.read_exact(&mut buf).map_err(|err| err.to_string())?;
  Ok(i32::from_be_bytes(buf))
}

fn read_i64(reader: &mut dyn Read) -> Result<i64, String> {
  let mut buf = [0_u8; 8];
  reader.read_exact(&mut buf).map_err(|err| err.to_string())?;
  Ok(i64::from_be_bytes(buf))
}

fn write_u16(writer: &mut dyn Write, value: u16) -> Result<(), String> {
  writer.write_all(&value.to_be_bytes()).map_err(|err| err.to_string())
}

fn write_u32(writer: &mut dyn Write, value: u32) -> Result<(), String> {
  writer.write_all(&value.to_be_bytes()).map_err(|err| err.to_string())
}

fn write_u64(writer: &mut dyn Write, value: u64) -> Result<(), String> {
  writer.write_all(&value.to_be_bytes()).map_err(|err| err.to_string())
}

fn write_i32(writer: &mut dyn Write, value: i32) -> Result<(), String> {
  writer.write_all(&value.to_be_bytes()).map_err(|err| err.to_string())
}

fn write_i64(writer: &mut dyn Write, value: i64) -> Result<(), String> {
  writer.write_all(&value.to_be_bytes()).map_err(|err| err.to_string())
}
