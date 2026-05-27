use std::{
  fmt::Write as _,
  io::{Cursor, Read, Seek, SeekFrom},
  path::Path,
};

use png::{BitDepth, ColorType, Encoder};

use crate::{
  application::models::{BundleNode, BundleResource},
  domain::bundle::audio::{self, AudioClipMeta},
};

const CLASS_TEXT_ASSET: i32 = 49;
const CLASS_TEXTURE2D: i32 = 28;
const CLASS_AUDIO_CLIP: i32 = 83;
const CLASS_SPRITE: i32 = 213;
const CLASS_MONO_BEHAVIOUR: i32 = 114;
const CLASS_MONO_SCRIPT: i32 = 115;
const CLASS_SHADER: i32 = 48;
const CLASS_MATERIAL: i32 = 21;
const CLASS_GAME_OBJECT: i32 = 1;
const CLASS_MESH: i32 = 43;
const CLASS_ANIMATOR: i32 = 95;
const CLASS_ANIMATION: i32 = 74;
const CLASS_VIDEO_CLIP: i32 = 329;
const CLASS_FONT: i32 = 128;

#[derive(Debug, Clone)]
pub struct SerializedObject {
  pub path_id: i64,
  pub offset: i64,
  pub size: i64,
  pub class_id: i32,
  pub meta_offset_pos: i64,
  pub meta_size_pos: i64,
}

#[derive(Debug, Clone)]
struct SerializedFile {
  big_endian: bool,
  version: i32,
  header_size: i64,
  data_offset: i64,
  objects: Vec<SerializedObject>,
}

#[derive(Debug, Clone, Default)]
struct Texture2DInfo {
  name: String,
  width: usize,
  height: usize,
  format: i32,
  mip_count: i32,
  is_readable: bool,
  data_size: usize,
  data: Vec<u8>,
  stream_offset: u64,
  stream_size: u32,
  stream_path: String,
  has_stream_data: bool,
}

pub struct ResourceExport {
  pub bytes: Vec<u8>,
  pub file_name: String,
  pub details: Option<String>,
}

pub fn extract_serialized_resources(node: &BundleNode, data: &[u8]) -> Vec<BundleResource> {
  let Ok(file) = parse_serialized_file(data) else {
    return Vec::new();
  };

  let mut resources = Vec::new();
  for (index, object) in file.objects.iter().enumerate() {
    let kind = kind_for_class(object.class_id);
    if kind == "binary" {
      continue;
    }
    let object_data = object_bytes(&file, object, data);
    if object_data.is_empty() {
      continue;
    }
    let (mut name, mut payload) = resource_name_and_payload(object.class_id, &object_data, file.big_endian);
    if name.is_empty() {
      name = format!("{}_{}", class_name(object.class_id), object.path_id);
    }
    let mut file_name = safe_resource_file_name(index, &name, kind, object.class_id);
    let mut details = None;
    match object.class_id {
      CLASS_TEXT_ASSET => {
        if payload.is_empty() {
          payload = object_data.clone();
        }
      }
      CLASS_AUDIO_CLIP => {
        if let Ok(meta) = parse_audio_clip(&object_data, file.big_endian) {
          details = Some(audio_details(&meta));
          file_name = replace_extension_or_suffix(&file_name, ".wav");
          payload.clear();
        } else {
          let meta = resource_metadata_with_preview(object, &name, &object_data, file.big_endian);
          details = Some(String::from_utf8_lossy(&meta).to_string());
          payload = meta;
          file_name = replace_extension_or_suffix(&file_name, ".meta.txt");
        }
      }
      _ => {
        let meta = resource_metadata_with_preview(object, &name, &object_data, file.big_endian);
        details = Some(String::from_utf8_lossy(&meta).to_string());
        payload = meta;
        file_name = replace_extension_or_suffix(&file_name, ".meta.txt");
      }
    }
    resources.push(BundleResource {
      id: resource_id(&node.id, object.path_id),
      node_id: node.id.clone(),
      node_path: node.path.clone(),
      path_id: object.path_id,
      class_id: object.class_id,
      r#type: class_name(object.class_id),
      name,
      kind: kind.to_string(),
      size: payload.len() as i64,
      crc: Some(crc_hex(&payload)),
      file_name,
      details,
      replaceable: object.class_id == CLASS_TEXT_ASSET,
      changed: false,
    });
  }
  resources.sort_by(|left, right| match left.kind.cmp(&right.kind) {
    std::cmp::Ordering::Equal => left.name.cmp(&right.name),
    other => other,
  });
  resources
}

pub fn resource_payload(resource: &BundleResource, node_data: &[u8]) -> Vec<u8> {
  let Ok(file) = parse_serialized_file(node_data) else {
    return Vec::new();
  };
  for object in &file.objects {
    if object.path_id != resource.path_id {
      continue;
    }
    let object_data = object_bytes(&file, object, node_data);
    if object_data.is_empty() {
      return Vec::new();
    }
    let (_, payload) = resource_name_and_payload(object.class_id, &object_data, file.big_endian);
    if !payload.is_empty() {
      return payload;
    }
    return resource_metadata_with_preview(object, &resource.name, &object_data, file.big_endian);
  }
  Vec::new()
}

pub fn export_resource(
  resource: &BundleResource,
  node_data: &[u8],
  nodes: &[BundleNode],
  bundle_payload: &[u8],
) -> Result<ResourceExport, String> {
  let file = parse_serialized_file(node_data)?;
  for object in &file.objects {
    if object.path_id != resource.path_id {
      continue;
    }
    let object_data = object_bytes(&file, object, node_data);
    if object_data.is_empty() {
      return Err(format!("资源对象范围非法: {}", resource.id));
    }
    match object.class_id {
      CLASS_TEXTURE2D => {
        let (png, details) = resource_preview_png(resource, node_data, nodes, bundle_payload)?;
        return Ok(ResourceExport {
          bytes: png,
          file_name: replace_extension_or_suffix(&resource.file_name, ".png"),
          details: Some(details),
        });
      }
      CLASS_AUDIO_CLIP => {
        let meta = parse_audio_clip(&object_data, file.big_endian)?;
        let audio_payload =
          find_audio_clip_payload(&meta, nodes, bundle_payload).ok_or_else(|| format!("找不到 AudioClip 源数据: {}", resource.name))?;
        let exported = audio::export_audio_clip(&resource.name, &audio_payload, &meta)?;
        return Ok(ResourceExport {
          bytes: exported.bytes,
          file_name: replace_extension_or_suffix(&resource.file_name, &format!(".{}", exported.extension)),
          details: Some(exported.details),
        });
      }
      _ => {
        let (_, payload) = resource_name_and_payload(object.class_id, &object_data, file.big_endian);
        if !payload.is_empty() {
          return Ok(ResourceExport {
            bytes: payload,
            file_name: resource.file_name.clone(),
            details: resource.details.clone(),
          });
        }
        let meta = resource_metadata_with_preview(object, &resource.name, &object_data, file.big_endian);
        return Ok(ResourceExport {
          bytes: meta.clone(),
          file_name: replace_extension_or_suffix(&resource.file_name, ".meta.txt"),
          details: Some(String::from_utf8_lossy(&meta).to_string()),
        });
      }
    }
  }
  Err(format!("资源对象不存在: {}", resource.id))
}

pub fn resource_preview_png(
  resource: &BundleResource,
  node_data: &[u8],
  nodes: &[BundleNode],
  bundle_payload: &[u8],
) -> Result<(Vec<u8>, String), String> {
  let file = parse_serialized_file(node_data)?;
  for object in &file.objects {
    if object.path_id != resource.path_id {
      continue;
    }
    let mut info = parse_texture2d(&object_bytes(&file, object, node_data), file.big_endian)?;
    if info.data.is_empty() && info.has_stream_data {
      info.data = find_texture_stream_data(&info, nodes, bundle_payload);
    }
    let rgba = decode_texture_rgba(&info)?;
    let png = encode_png_rgba(info.width, info.height, &rgba)?;
    return Ok((png, texture2d_details(&info)));
  }
  Err(format!("Texture2D 对象不存在: {}", resource.id))
}

pub fn replace_serialized_resource(node_data: &[u8], resource: &BundleResource, replacement: &[u8]) -> Result<Vec<u8>, String> {
  if resource.class_id != CLASS_TEXT_ASSET {
    return Err("暂只支持替换 TextAsset 资源".to_string());
  }
  let file = parse_serialized_file(node_data)?;
  let mut replaced = false;
  let mut objects = file.objects.clone();
  let mut object_payloads = std::collections::BTreeMap::new();

  for object in &mut objects {
    let mut data = object_bytes(&file, object, node_data);
    if data.is_empty() {
      return Err(format!("资源对象范围非法: {}", object.path_id));
    }
    if object.path_id == resource.path_id {
      data = replace_text_asset_payload(&data, file.big_endian, replacement)?;
      object.size = data.len() as i64;
      replaced = true;
    }
    object_payloads.insert(object.path_id, data);
  }

  if !replaced {
    return Err(format!("资源对象不存在: {}", resource.id));
  }

  let prefix_len = usize::try_from(file.data_offset).map_err(|_| "序列化节点数据偏移非法".to_string())?;
  if prefix_len > node_data.len() {
    return Err("序列化节点数据偏移超出范围".to_string());
  }
  let mut prefix = node_data[..prefix_len].to_vec();

  let mut sorted = objects.clone();
  sorted.sort_by_key(|object| object.offset);
  let mut body = Vec::new();
  for object in &sorted {
    let padding = align_padding(body.len(), 8);
    if padding > 0 {
      body.resize(body.len() + padding, 0);
    }
    let new_offset = body.len() as i64;
    let payload = object_payloads
      .get(&object.path_id)
      .ok_or_else(|| format!("对象数据缺失: {}", object.path_id))?;
    body.extend_from_slice(payload);
    if let Some(target) = objects.iter_mut().find(|item| item.path_id == object.path_id) {
      target.offset = new_offset;
      target.size = payload.len() as i64;
    }
  }

  for object in &objects {
    write_at(&mut prefix, file.header_size + object.meta_offset_pos, object.offset as u64, 8, file.big_endian);
    write_at(&mut prefix, file.header_size + object.meta_size_pos, object.size as u64, 4, file.big_endian);
  }

  let mut output = prefix;
  output.extend_from_slice(&body);
  if file.version >= 22 {
    if output.len() >= 32 {
      let total_len = output.len() as u64;
      output[24..32].copy_from_slice(&total_len.to_be_bytes());
    }
  } else if output.len() >= 8 {
    let total_len = output.len() as u32;
    output[4..8].copy_from_slice(&total_len.to_be_bytes());
  }
  Ok(output)
}

pub fn classify_bundle_resource_kind(kind: &str) -> &'static str {
  match kind {
    "image" => "image",
    "text" => "text",
    "audio" => "audio",
    _ => "other",
  }
}

pub fn parse_serialized_file(data: &[u8]) -> Result<SerializedFile, String> {
  if data.len() < 32 {
    return Err("serialized file too short".to_string());
  }
  let mut metadata_size = u32::from_be_bytes(data[0..4].try_into().unwrap_or([0; 4])) as i64;
  let mut file_size = u32::from_be_bytes(data[4..8].try_into().unwrap_or([0; 4])) as i64;
  let version = u32::from_be_bytes(data[8..12].try_into().unwrap_or([0; 4])) as i32;
  let mut data_offset = u32::from_be_bytes(data[12..16].try_into().unwrap_or([0; 4])) as i64;
  let mut endian = data[16];
  let mut header_size = 20_i64;

  if version >= 22 {
    if data.len() < 48 {
      return Err("serialized file v22 header too short".to_string());
    }
    metadata_size = u32::from_be_bytes(data[20..24].try_into().unwrap_or([0; 4])) as i64;
    file_size = u64::from_be_bytes(data[24..32].try_into().unwrap_or([0; 8])) as i64;
    data_offset = u64::from_be_bytes(data[32..40].try_into().unwrap_or([0; 8])) as i64;
    endian = data[40];
    header_size = 48;
  }

  if file_size <= 0 || file_size > data.len() as i64 + 4096 || data_offset <= 0 || data_offset > data.len() as i64 {
    return Err("invalid serialized header".to_string());
  }
  if metadata_size <= 0 || header_size + metadata_size > data.len() as i64 {
    return Err("invalid metadata size".to_string());
  }

  let big_endian = endian != 0;
  let meta_start = usize::try_from(header_size).map_err(|_| "metadata 起始位置非法".to_string())?;
  let meta_end = usize::try_from(header_size + metadata_size).map_err(|_| "metadata 结束位置非法".to_string())?;
  let mut reader = EndianCursor::new(data[meta_start..meta_end].to_vec(), big_endian);

  let _unity_version = reader.read_c_string()?;
  let _target_platform = reader.i32()?;
  let mut has_type_trees = true;
  if version >= 13 {
    has_type_trees = reader.u8()? != 0;
  }

  let type_count = reader.i32()?;
  if !(0..=10000).contains(&type_count) {
    return Err("invalid type count".to_string());
  }
  let mut type_classes = Vec::with_capacity(type_count as usize);
  for _ in 0..type_count {
    let class_id = reader.i32()?;
    type_classes.push(class_id);
    if version >= 16 {
      let _ = reader.u8()?;
    }
    if version >= 17 {
      let _ = reader.i16()?;
    }
    if version >= 16 {
      if class_id == CLASS_MONO_BEHAVIOUR {
        let _ = reader.read_n(16)?;
      }
      if class_id < 0 {
        let _ = reader.read_n(16)?;
      }
    }
    if version >= 13 {
      let _ = reader.read_n(16)?;
    }
    if has_type_trees {
      skip_type_tree(&mut reader, version)?;
      if version >= 21 {
        let dependency_count = reader.i32()?;
        if !(0..=100000).contains(&dependency_count) {
          return Err(format!("invalid type dependency count: {dependency_count}"));
        }
        let bytes = usize::try_from(dependency_count).map_err(|_| "type dependency count overflow".to_string())? * 4;
        let _ = reader.read_n(bytes)?;
      }
    }
  }

  let object_count = reader.i32()?;
  if !(0..=1_000_000).contains(&object_count) {
    return Err("invalid object count".to_string());
  }

  let mut objects = Vec::with_capacity(object_count as usize);
  for _ in 0..object_count {
    let path_id = if version >= 14 {
      reader.align(4)?;
      reader.i64()?
    } else {
      reader.i32()? as i64
    };
    let meta_offset_pos = reader.position();
    let offset = reader.u64()? as i64;
    let meta_size_pos = reader.position();
    let size = reader.u32()? as i64;
    let type_id = reader.i32()?;
    let class_id = if type_id >= 0 && (type_id as usize) < type_classes.len() {
      type_classes[type_id as usize]
    } else {
      type_id
    };
    objects.push(SerializedObject {
      path_id,
      offset,
      size,
      class_id,
      meta_offset_pos,
      meta_size_pos,
    });
    if version < 11 {
      let _ = reader.i16()?;
    }
    if (11..17).contains(&version) {
      let _ = reader.i16()?;
    }
  }

  Ok(SerializedFile {
    big_endian,
    version,
    header_size,
    data_offset,
    objects,
  })
}

fn object_bytes(file: &SerializedFile, object: &SerializedObject, data: &[u8]) -> Vec<u8> {
  let start = file.data_offset + object.offset;
  let end = start + object.size;
  if start < 0 || end < start || end > data.len() as i64 {
    return Vec::new();
  }
  data[start as usize..end as usize].to_vec()
}

fn resource_name_and_payload(class_id: i32, data: &[u8], big_endian: bool) -> (String, Vec<u8>) {
  let mut reader = EndianCursor::new(data.to_vec(), big_endian);
  let Ok(name) = reader.read_aligned_string() else {
    return (String::new(), Vec::new());
  };
  match class_id {
    CLASS_TEXT_ASSET => {
      let Ok(size) = reader.i32() else {
        return (name, Vec::new());
      };
      if size < 0 || size as usize > reader.remaining() {
        return (name, Vec::new());
      }
      let Ok(payload) = reader.read_n(size as usize) else {
        return (name, Vec::new());
      };
      (name, payload)
    }
    _ => (name, Vec::new()),
  }
}

fn replace_text_asset_payload(data: &[u8], big_endian: bool, replacement: &[u8]) -> Result<Vec<u8>, String> {
  let mut reader = EndianCursor::new(data.to_vec(), big_endian);
  let _name = reader.read_aligned_string()?;
  let size_pos = reader.position() as usize;
  let old_size = reader.i32()?;
  if old_size < 0 || old_size as usize > reader.remaining() {
    return Err("TextAsset 内容大小异常".to_string());
  }
  let payload_start = reader.position() as usize;
  let payload_end = payload_start + old_size as usize;
  let aligned_end = payload_end + align_padding(payload_end, 4);
  if aligned_end > data.len() {
    return Err("TextAsset 内容范围异常".to_string());
  }
  let mut out = Vec::new();
  out.extend_from_slice(&data[..size_pos]);
  if big_endian {
    out.extend_from_slice(&(replacement.len() as u32).to_be_bytes());
  } else {
    out.extend_from_slice(&(replacement.len() as u32).to_le_bytes());
  }
  out.extend_from_slice(replacement);
  let padding = align_padding(out.len(), 4);
  if padding > 0 {
    out.resize(out.len() + padding, 0);
  }
  out.extend_from_slice(&data[aligned_end..]);
  Ok(out)
}

fn parse_texture2d(data: &[u8], big_endian: bool) -> Result<Texture2DInfo, String> {
  let mut reader = EndianCursor::new(data.to_vec(), big_endian);
  let name = reader.read_aligned_string()?;
  let _ = reader.i32()?;
  let _ = reader.i32()?;
  let width = reader.i32()? as usize;
  let height = reader.i32()? as usize;
  let _complete_size = reader.i32()?;
  let _ = reader.i32()?;
  let texture_format = reader.i32()?;
  let mip_count = reader.i32()?;
  let readable = reader.i32()?;
  for _ in 0..12 {
    let _ = reader.i32()?;
  }
  let data_size = reader.i32()?;
  if data_size < 0 || data_size as usize > reader.remaining() {
    return Err("Texture2D 数据大小异常".to_string());
  }
  let payload = reader.read_n(data_size as usize)?;
  reader.align(4)?;

  let mut info = Texture2DInfo {
    name,
    width,
    height,
    format: texture_format,
    mip_count,
    is_readable: readable != 0,
    data_size: data_size as usize,
    data: payload,
    ..Default::default()
  };

  if reader.remaining() > 0 {
    if let Ok(stream_offset) = reader.u64() {
      if let Ok(stream_size) = reader.u32() {
        if let Ok(stream_path) = reader.read_aligned_string() {
          info.stream_offset = stream_offset;
          info.stream_size = stream_size;
          info.stream_path = stream_path;
          info.has_stream_data = stream_size > 0 || !info.stream_path.is_empty();
        }
      }
    }
  }

  Ok(info)
}

fn parse_audio_clip(data: &[u8], big_endian: bool) -> Result<AudioClipMeta, String> {
  let mut reader = EndianCursor::new(data.to_vec(), big_endian);
  let name = reader.read_aligned_string()?;
  let _load_type = reader.i32()?;
  let channels = reader.i32()?;
  let frequency = reader.i32()?;
  let bits_per_sample = reader.i32()?;
  let length_seconds = reader.f32()?;
  let _is_tracker_format = reader.bool()?;
  reader.align(4)?;
  let _subsound_index = reader.i32()?;
  let _preload_audio_data = reader.bool()?;
  let _load_in_background = reader.bool()?;
  let _legacy_3d = reader.bool()?;
  reader.align(4)?;
  let source = reader.read_aligned_string()?;
  let offset = reader.i64()?;
  let size = reader.i64()?;
  let compression_format = reader.i32()?;
  Ok(AudioClipMeta {
    name,
    channels: channels.max(0) as u32,
    frequency: frequency.max(0) as u32,
    bits_per_sample: bits_per_sample.max(0) as u32,
    length_seconds,
    source,
    offset: offset.max(0) as u64,
    size: size.max(0) as u64,
    compression_format,
  })
}

fn decode_texture_rgba(info: &Texture2DInfo) -> Result<Vec<u8>, String> {
  if info.width == 0 || info.height == 0 {
    return Err(format!("Texture2D 尺寸异常: {}x{}", info.width, info.height));
  }
  match info.format {
    3 => decode_rgb24(info),
    4 => decode_rgba32(info),
    5 => decode_argb32(info),
    47 => decode_etc2_rgba8(info),
    other => Err(format!("暂不支持 TextureFormat {other} ({})", texture_format_name(other))),
  }
}

fn decode_rgb24(info: &Texture2DInfo) -> Result<Vec<u8>, String> {
  let need = info.width * info.height * 3;
  if info.data.len() < need {
    return Err(format!("Texture2D 数据不足: {} < {need}", info.data.len()));
  }
  let mut rgba = Vec::with_capacity(info.width * info.height * 4);
  for chunk in info.data[..need].chunks_exact(3) {
    rgba.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 0xff]);
  }
  Ok(flip_rgba_rows(info.width, info.height, &rgba))
}

fn decode_rgba32(info: &Texture2DInfo) -> Result<Vec<u8>, String> {
  let need = info.width * info.height * 4;
  if info.data.len() < need {
    return Err(format!("Texture2D 数据不足: {} < {need}", info.data.len()));
  }
  Ok(flip_rgba_rows(info.width, info.height, &info.data[..need]))
}

fn decode_argb32(info: &Texture2DInfo) -> Result<Vec<u8>, String> {
  let need = info.width * info.height * 4;
  if info.data.len() < need {
    return Err(format!("Texture2D 数据不足: {} < {need}", info.data.len()));
  }
  let mut rgba = Vec::with_capacity(need);
  for chunk in info.data[..need].chunks_exact(4) {
    rgba.extend_from_slice(&[chunk[1], chunk[2], chunk[3], chunk[0]]);
  }
  Ok(flip_rgba_rows(info.width, info.height, &rgba))
}

fn decode_etc2_rgba8(info: &Texture2DInfo) -> Result<Vec<u8>, String> {
  if info.data.is_empty() {
    return Err("Texture2D 没有内嵌像素数据".to_string());
  }
  let mut output = vec![0_u32; info.width * info.height];
  texture2ddecoder::decode_etc2_rgba8(&info.data, info.width, info.height, &mut output)
    .map_err(|err| format!("ETC2_RGBA8 解码失败: {err}"))?;
  let mut rgba = Vec::with_capacity(output.len() * 4);
  for pixel in output {
    rgba.push((pixel & 0xff) as u8);
    rgba.push(((pixel >> 8) & 0xff) as u8);
    rgba.push(((pixel >> 16) & 0xff) as u8);
    rgba.push(((pixel >> 24) & 0xff) as u8);
  }
  Ok(flip_rgba_rows(info.width, info.height, &rgba))
}

fn flip_rgba_rows(width: usize, height: usize, rgba: &[u8]) -> Vec<u8> {
  let stride = width.saturating_mul(4);
  if stride == 0 || rgba.len() < stride.saturating_mul(height) {
    return rgba.to_vec();
  }
  let mut flipped = vec![0_u8; stride * height];
  for row in 0..height {
    let src_start = row * stride;
    let dst_start = (height - 1 - row) * stride;
    flipped[dst_start..dst_start + stride].copy_from_slice(&rgba[src_start..src_start + stride]);
  }
  flipped
}

fn find_texture_stream_data(info: &Texture2DInfo, nodes: &[BundleNode], payload: &[u8]) -> Vec<u8> {
  if info.stream_size == 0 {
    return Vec::new();
  }
  let mut path = info.stream_path.trim_start_matches("archive:/").to_string();
  if let Some(index) = path.find('/') {
    path = path[index + 1..].to_string();
  }
  let path = path.trim().to_string();
  for node in nodes {
    if !path.is_empty() {
      let node_base = Path::new(&node.path).file_name().and_then(|value| value.to_str()).unwrap_or("");
      let path_base = Path::new(&path).file_name().and_then(|value| value.to_str()).unwrap_or("");
      if node_base != path_base && node.path != path {
        continue;
      }
    }
    let start = node.offset + info.stream_offset as i64;
    let end = start + info.stream_size as i64;
    if start >= 0 && end >= start && end <= payload.len() as i64 {
      return payload[start as usize..end as usize].to_vec();
    }
  }
  Vec::new()
}

fn find_audio_clip_payload(meta: &AudioClipMeta, nodes: &[BundleNode], payload: &[u8]) -> Option<Vec<u8>> {
  let mut path = meta.source.trim_start_matches("archive:/").to_string();
  if let Some(index) = path.find('/') {
    path = path[index + 1..].to_string();
  }
  let path = path.trim();
  if path.is_empty() {
    return None;
  }
  for node in nodes {
    let node_base = Path::new(&node.path).file_name().and_then(|value| value.to_str()).unwrap_or("");
    let path_base = Path::new(path).file_name().and_then(|value| value.to_str()).unwrap_or("");
    if node_base != path_base && node.path != path {
      continue;
    }
    let start = node.offset.checked_add(meta.offset as i64)?;
    let end = start.checked_add(meta.size as i64)?;
    if start < 0 || end < start || end > payload.len() as i64 {
      return None;
    }
    return Some(payload[start as usize..end as usize].to_vec());
  }
  None
}

fn encode_png_rgba(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
  let mut out = Vec::new();
  let mut encoder = Encoder::new(&mut out, width as u32, height as u32);
  encoder.set_color(ColorType::Rgba);
  encoder.set_depth(BitDepth::Eight);
  let mut writer = encoder.write_header().map_err(|err| err.to_string())?;
  writer.write_image_data(rgba).map_err(|err| err.to_string())?;
  drop(writer);
  Ok(out)
}

fn texture2d_details(info: &Texture2DInfo) -> String {
  format!(
    "texture_width: {}\ntexture_height: {}\ntexture_format: {} ({})\nmip_count: {}\nreadable: {}\nimage_data_size: {}\nstream_size: {}\nstream_offset: {}\nstream_path: {}",
    info.width,
    info.height,
    info.format,
    texture_format_name(info.format),
    info.mip_count,
    info.is_readable,
    info.data_size,
    info.stream_size,
    info.stream_offset,
    empty_string(&info.stream_path),
  )
}

fn audio_details(info: &AudioClipMeta) -> String {
  format!(
    "audio_name: {}\naudio_channels: {}\naudio_frequency: {}\naudio_bits_per_sample: {}\naudio_duration_seconds: {:.3}\naudio_source: {}\naudio_offset: {}\naudio_size: {}\naudio_compression_format: {}",
    empty_string(&info.name),
    info.channels,
    info.frequency,
    info.bits_per_sample,
    info.length_seconds,
    empty_string(&info.source),
    info.offset,
    info.size,
    audio_compression_format_name(info.compression_format),
  )
}

fn audio_compression_format_name(value: i32) -> &'static str {
  match value {
    0 => "PCM",
    1 => "Vorbis",
    2 => "ADPCM",
    3 => "MP3",
    4 => "PSMVAG",
    5 => "HEVAG",
    6 => "XMA",
    7 => "AAC",
    8 => "GCADPCM",
    9 => "ATRAC9",
    _ => "Unknown",
  }
}

fn texture_format_name(format: i32) -> &'static str {
  match format {
    3 => "RGB24",
    4 => "RGBA32",
    5 => "ARGB32",
    10 => "DXT1",
    12 => "DXT5",
    34 => "ETC_RGB4",
    45 => "ETC2_RGB",
    46 => "ETC2_RGBA1",
    47 => "ETC2_RGBA8",
    48 => "ASTC_RGB_4x4",
    49 => "ASTC_RGB_5x5",
    50 => "ASTC_RGB_6x6",
    51 => "ASTC_RGB_8x8",
    52 => "ASTC_RGB_10x10",
    53 => "ASTC_RGB_12x12",
    54 => "ASTC_RGBA_4x4",
    55 => "ASTC_RGBA_5x5",
    56 => "ASTC_RGBA_6x6",
    57 => "ASTC_RGBA_8x8",
    58 => "ASTC_RGBA_10x10",
    59 => "ASTC_RGBA_12x12",
    _ => "Unknown",
  }
}

fn skip_type_tree(reader: &mut EndianCursor, version: i32) -> Result<(), String> {
  if version >= 12 || version == 10 {
    let node_count = u32::from_le_bytes(reader.read_n(4)?.try_into().unwrap_or([0; 4])) as usize;
    let string_buffer_size = u32::from_le_bytes(reader.read_n(4)?.try_into().unwrap_or([0; 4])) as usize;
    if node_count > 1_000_000 || string_buffer_size > 64 * 1024 * 1024 {
      return Err("invalid type tree".to_string());
    }
    let node_size = if version >= 19 { 32 } else { 24 };
    let need = node_count
      .checked_mul(node_size)
      .and_then(|value| value.checked_add(string_buffer_size))
      .ok_or_else(|| "type tree overflow".to_string())?;
    let _ = reader.read_n(need)?;
    return Ok(());
  }
  skip_old_type_tree(reader)
}

fn skip_old_type_tree(reader: &mut EndianCursor) -> Result<(), String> {
  let _ = reader.read_c_string()?;
  let _ = reader.read_c_string()?;
  let _ = reader.read_n(20)?;
  let children = u32::from_le_bytes(reader.read_n(4)?.try_into().unwrap_or([0; 4])) as usize;
  if children > 100_000 {
    return Err("invalid old type tree".to_string());
  }
  for _ in 0..children {
    skip_old_type_tree(reader)?;
  }
  Ok(())
}

fn resource_id(node_id: &str, path_id: i64) -> String {
  format!("{node_id}:{path_id}")
}

fn safe_resource_file_name(index: usize, name: &str, kind: &str, class_id: i32) -> String {
  let mut clean = name.trim().to_string();
  if clean.is_empty() {
    clean = format!("{}_{}", class_name(class_id), index);
  }
  clean = sanitize_filename(&clean);
  let ext = resource_ext(kind, class_id);
  if Path::new(&clean).extension().is_none() {
    clean.push_str(ext);
  }
  format!("{index:04}_{clean}")
}

fn resource_ext(kind: &str, class_id: i32) -> &'static str {
  match class_id {
    CLASS_TEXT_ASSET | CLASS_MONO_SCRIPT => ".txt",
    CLASS_SHADER => ".shader",
    CLASS_AUDIO_CLIP => ".wav",
    _ if kind == "image" => ".image.txt",
    _ if kind == "audio" => ".audio.txt",
    _ => ".meta.txt",
  }
}

fn kind_for_class(class_id: i32) -> &'static str {
  match class_id {
    CLASS_TEXT_ASSET | CLASS_MONO_SCRIPT | CLASS_SHADER => "text",
    CLASS_TEXTURE2D | CLASS_SPRITE => "image",
    CLASS_AUDIO_CLIP | CLASS_VIDEO_CLIP => "audio",
    _ => "binary",
  }
}

fn class_name(class_id: i32) -> String {
  match class_id {
    CLASS_GAME_OBJECT => "GameObject",
    CLASS_MATERIAL => "Material",
    CLASS_TEXTURE2D => "Texture2D",
    CLASS_SHADER => "Shader",
    CLASS_TEXT_ASSET => "TextAsset",
    CLASS_MESH => "Mesh",
    CLASS_ANIMATION => "AnimationClip",
    CLASS_AUDIO_CLIP => "AudioClip",
    CLASS_ANIMATOR => "AnimatorController",
    CLASS_MONO_SCRIPT => "MonoScript",
    CLASS_FONT => "Font",
    CLASS_SPRITE => "Sprite",
    CLASS_VIDEO_CLIP => "VideoClip",
    CLASS_MONO_BEHAVIOUR => "MonoBehaviour",
    _ => return format!("Class{class_id}"),
  }
  .to_string()
}

fn resource_metadata_with_preview(object: &SerializedObject, name: &str, data: &[u8], big_endian: bool) -> Vec<u8> {
  let preview = if data.is_empty() {
    String::new()
  } else {
    let limit = data.len().min(64);
    hex_string(&data[..limit])
  };
  let extra = if object.class_id == CLASS_TEXTURE2D {
    parse_texture2d(data, big_endian)
      .ok()
      .map(|info| format!("\n{}", texture2d_details(&info)))
      .unwrap_or_default()
  } else {
    String::new()
  };
  format!(
    "name: {name}\ntype: {}\nclass_id: {}\npath_id: {}\nobject_size: {}{}\nraw_preview: {preview}\n",
    class_name(object.class_id),
    object.class_id,
    object.path_id,
    object.size,
    extra
  )
  .into_bytes()
}

fn write_at(data: &mut [u8], offset: i64, value: u64, size: usize, big_endian: bool) {
  if offset < 0 {
    return;
  }
  let offset = offset as usize;
  if offset + size > data.len() {
    return;
  }
  match size {
    4 => {
      let bytes = if big_endian {
        (value as u32).to_be_bytes()
      } else {
        (value as u32).to_le_bytes()
      };
      data[offset..offset + 4].copy_from_slice(&bytes);
    }
    8 => {
      let bytes = if big_endian { value.to_be_bytes() } else { value.to_le_bytes() };
      data[offset..offset + 8].copy_from_slice(&bytes);
    }
    _ => {}
  }
}

fn replace_extension_or_suffix(file_name: &str, suffix: &str) -> String {
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

fn empty_string(value: &str) -> &str {
  if value.is_empty() {
    "-"
  } else {
    value
  }
}

fn crc_hex(data: &[u8]) -> String {
  format!("{:08x}", crc32fast::hash(data))
}

fn hex_string(bytes: &[u8]) -> String {
  let mut out = String::with_capacity(bytes.len() * 2);
  for byte in bytes {
    let _ = write!(out, "{byte:02x}");
  }
  out
}

#[derive(Debug, Clone)]
struct EndianCursor {
  cursor: Cursor<Vec<u8>>,
  big_endian: bool,
}

impl EndianCursor {
  fn new(data: Vec<u8>, big_endian: bool) -> Self {
    Self {
      cursor: Cursor::new(data),
      big_endian,
    }
  }

  fn order_u16(&self, bytes: [u8; 2]) -> u16 {
    if self.big_endian {
      u16::from_be_bytes(bytes)
    } else {
      u16::from_le_bytes(bytes)
    }
  }

  fn order_u32(&self, bytes: [u8; 4]) -> u32 {
    if self.big_endian {
      u32::from_be_bytes(bytes)
    } else {
      u32::from_le_bytes(bytes)
    }
  }

  fn order_u64(&self, bytes: [u8; 8]) -> u64 {
    if self.big_endian {
      u64::from_be_bytes(bytes)
    } else {
      u64::from_le_bytes(bytes)
    }
  }

  fn position(&self) -> i64 {
    self.cursor.position() as i64
  }

  fn remaining(&self) -> usize {
    self.cursor.get_ref().len().saturating_sub(self.cursor.position() as usize)
  }

  fn read_n(&mut self, size: usize) -> Result<Vec<u8>, String> {
    if size > self.remaining() {
      return Err("unexpected eof".to_string());
    }
    let mut out = vec![0_u8; size];
    self.cursor.read_exact(&mut out).map_err(|err| err.to_string())?;
    Ok(out)
  }

  fn read_c_string(&mut self) -> Result<String, String> {
    let mut out = Vec::new();
    loop {
      let mut byte = [0_u8; 1];
      self.cursor.read_exact(&mut byte).map_err(|err| err.to_string())?;
      if byte[0] == 0 {
        return String::from_utf8(out).map_err(|err| err.to_string());
      }
      out.push(byte[0]);
      if out.len() > 1024 * 1024 {
        return Err("string too long".to_string());
      }
    }
  }

  fn read_aligned_string(&mut self) -> Result<String, String> {
    let size = self.i32()?;
    if size < 0 || size as usize > self.remaining() {
      return Err("invalid aligned string".to_string());
    }
    let data = self.read_n(size as usize)?;
    self.align(4)?;
    Ok(String::from_utf8_lossy(&data).trim_end_matches('\0').to_string())
  }

  fn align(&mut self, align: usize) -> Result<(), String> {
    let padding = align_padding(self.cursor.position() as usize, align);
    if padding > self.remaining() {
      return Err("alignment exceeds remaining bytes".to_string());
    }
    self.cursor
      .seek(SeekFrom::Current(padding as i64))
      .map_err(|err| err.to_string())?;
    Ok(())
  }

  fn u8(&mut self) -> Result<u8, String> {
    Ok(self.read_n(1)?[0])
  }

  fn bool(&mut self) -> Result<bool, String> {
    Ok(self.u8()? != 0)
  }

  fn i16(&mut self) -> Result<i16, String> {
    let bytes: [u8; 2] = self.read_n(2)?.try_into().unwrap_or([0; 2]);
    Ok(self.order_u16(bytes) as i16)
  }

  fn i32(&mut self) -> Result<i32, String> {
    let bytes: [u8; 4] = self.read_n(4)?.try_into().unwrap_or([0; 4]);
    Ok(self.order_u32(bytes) as i32)
  }

  fn u32(&mut self) -> Result<u32, String> {
    let bytes: [u8; 4] = self.read_n(4)?.try_into().unwrap_or([0; 4]);
    Ok(self.order_u32(bytes))
  }

  fn f32(&mut self) -> Result<f32, String> {
    let bytes: [u8; 4] = self.read_n(4)?.try_into().unwrap_or([0; 4]);
    let bits = self.order_u32(bytes);
    Ok(f32::from_bits(bits))
  }

  fn i64(&mut self) -> Result<i64, String> {
    let bytes: [u8; 8] = self.read_n(8)?.try_into().unwrap_or([0; 8]);
    Ok(self.order_u64(bytes) as i64)
  }

  fn u64(&mut self) -> Result<u64, String> {
    let bytes: [u8; 8] = self.read_n(8)?.try_into().unwrap_or([0; 8]);
    Ok(self.order_u64(bytes))
  }
}
