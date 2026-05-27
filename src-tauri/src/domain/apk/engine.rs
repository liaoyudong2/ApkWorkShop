use std::{
  collections::BTreeMap,
  fs::{self, File},
  io::{self, Read},
  os::unix::fs::FileExt,
  path::{Path, PathBuf},
  process::Command,
};

use serde_json::Value;
use zip::{read::ZipFile, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
  application::models::{
    AddressablesInfo, BuildResult, Counts, Entry, Manifest, Replacement, ScanReport, SignatureInfo, ToolStatus,
    UnityInfo,
  },
  support::shared,
};

pub const MANIFEST_NAME: &str = "manifest.json";

const SIGNATURE_SUFFIXES: [&str; 4] = [".SF", ".RSA", ".DSA", ".EC"];
const APK_SIGN_BLOCK_MAGIC: &[u8] = b"APK Sig Block 42";

pub fn default_apk(root: &Path) -> Option<PathBuf> {
  let apk_dir = root.join("apk");
  let mut matches = fs::read_dir(apk_dir)
    .ok()?
    .filter_map(Result::ok)
    .map(|entry| entry.path())
    .filter(|path| path.extension().map(|ext| ext.eq_ignore_ascii_case("apk")).unwrap_or(false))
    .collect::<Vec<_>>();
  matches.sort();
  matches.into_iter().next()
}

pub fn scan(apk_path: &Path) -> Result<ScanReport, String> {
  let apk_path = apk_path.to_path_buf();
  let metadata = fs::metadata(&apk_path).map_err(|err| format!("APK 不存在: {err}"))?;
  if metadata.is_dir() || apk_path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("apk")) != Some(true)
  {
    return Err(format!("目标不是 APK 文件: {}", apk_path.display()));
  }

  let file = File::open(&apk_path).map_err(|err| err.to_string())?;
  let mut archive = ZipArchive::new(file).map_err(|err| format!("不是有效 APK/ZIP: {err}"))?;

  let mut names = Vec::with_capacity(archive.len());
  let mut settings: Option<Value> = None;
  let mut catalog: Option<Value> = None;
  for index in 0..archive.len() {
    let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
    names.push(entry.name().to_string());
    match entry.name() {
      "assets/aa/settings.json" => {
        settings = read_zip_json(&mut entry).ok();
      }
      "assets/aa/catalog.json" => {
        catalog = read_zip_json(&mut entry).ok();
      }
      _ => {}
    }
  }

  Ok(ScanReport {
    apk: shared::must_abs(&apk_path),
    name: apk_path.file_name().and_then(|value| value.to_str()).unwrap_or("unknown.apk").to_string(),
    size_bytes: metadata.len(),
    entry_count: names.len(),
    counts: count_names(&names),
    unity: detect_unity(&names, settings.is_some() || catalog.is_some()),
    signature: detect_signature(&apk_path, &names),
    addressables: parse_addressables(settings.as_ref(), catalog.as_ref()),
    optional_tools: tool_status_map(),
  })
}

pub fn extract(apk_path: &Path, work_dir: &Path, force: bool) -> Result<Manifest, String> {
  let scan = scan(apk_path)?;
  if let Ok(stat) = fs::metadata(work_dir) {
    if !stat.is_dir() {
      return Err(format!("输出路径不是目录: {}", work_dir.display()));
    }
    if force {
      fs::remove_dir_all(work_dir).map_err(|err| err.to_string())?;
    } else if !shared::dir_is_empty(work_dir)? {
      return Err(format!("工作区非空: {}", work_dir.display()));
    }
  }
  fs::create_dir_all(work_dir).map_err(|err| err.to_string())?;

  let file = File::open(apk_path).map_err(|err| err.to_string())?;
  let mut archive = ZipArchive::new(file).map_err(|err| format!("不是有效 APK/ZIP: {err}"))?;
  let mut entries = Vec::with_capacity(archive.len());

  for index in 0..archive.len() {
    let mut item = archive.by_index(index).map_err(|err| err.to_string())?;
    let safe_path = shared::validate_apk_path(item.name())?;
    let entry = entry_from_zip(&item);
    entries.push(entry);
    let target = work_dir.join(safe_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if item.is_dir() {
      fs::create_dir_all(&target).map_err(|err| err.to_string())?;
      continue;
    }
    if let Some(parent) = target.parent() {
      fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut output = File::create(&target).map_err(|err| err.to_string())?;
    io::copy(&mut item, &mut output).map_err(|err| err.to_string())?;
  }

  let manifest = Manifest {
    schema_version: 1,
    tool: "apkworkshop-tauri".to_string(),
    source_apk: shared::must_abs(apk_path),
    source_size: scan.size_bytes,
    extracted_at: shared::now_rfc3339(),
    entries,
    replacements: Vec::new(),
  };
  write_manifest(work_dir, &manifest)?;
  Ok(manifest)
}

pub fn load_manifest(work_dir: &Path) -> Result<Manifest, String> {
  let mut manifest: Manifest = shared::read_json_file(&work_dir.join(MANIFEST_NAME))?;
  let mut changed = BTreeMap::new();
  for item in &manifest.replacements {
    changed.insert(item.path.clone(), true);
  }
  for entry in &mut manifest.entries {
    entry.changed = changed.get(&entry.path).copied().unwrap_or(false);
  }
  Ok(manifest)
}

pub fn write_manifest(work_dir: &Path, manifest: &Manifest) -> Result<(), String> {
  shared::write_json_file(&work_dir.join(MANIFEST_NAME), manifest)
}

pub fn replace(work_dir: &Path, target_path: &str, source_path: &Path) -> Result<(Replacement, Manifest), String> {
  let mut manifest = load_manifest(work_dir)?;
  let target_path = shared::validate_apk_path(target_path)?;
  if is_signature_file(&target_path) {
    return Err(format!("不能替换旧签名文件: {target_path}"));
  }
  let entry = manifest
    .entries
    .iter_mut()
    .find(|entry| entry.path == target_path)
    .ok_or_else(|| format!("清单中不存在路径: {target_path}"))?;
  if entry.is_dir {
    return Err(format!("不能替换目录: {target_path}"));
  }
  if !entry.replaceable {
    return Err(format!("该类型暂不支持替换: {target_path}"));
  }
  let source_meta = fs::metadata(source_path).map_err(|_| format!("替换文件不可用: {}", source_path.display()))?;
  if source_meta.is_dir() {
    return Err(format!("替换文件不可用: {}", source_path.display()));
  }
  let dest = work_dir.join(target_path.replace('/', std::path::MAIN_SEPARATOR_STR));
  shared::copy_file(source_path, &dest)?;
  let (size, crc) = shared::file_crc(&dest)?;
  entry.changed = true;
  let record = Replacement {
    kind: Some("apk-file".to_string()),
    path: target_path.clone(),
    source_path: shared::must_abs(source_path),
    size,
    crc,
    replaced_at: shared::now_rfc3339(),
    node_id: None,
    node_path: None,
    resource_id: None,
  };
  manifest.replacements.push(record.clone());
  write_manifest(work_dir, &manifest)?;
  Ok((record, manifest))
}

pub fn mark_bundle_replacement(
  work_dir: &Path,
  bundle_path: &str,
  node_id: Option<String>,
  node_path: Option<String>,
  resource_id: Option<String>,
  source_path: String,
  size: u64,
  crc: String,
) -> Result<Manifest, String> {
  let mut manifest = load_manifest(work_dir)?;
  let bundle_path = shared::validate_apk_path(bundle_path)?;
  let entry = manifest
    .entries
    .iter_mut()
    .find(|entry| entry.path == bundle_path)
    .ok_or_else(|| format!("清单中不存在 Bundle: {bundle_path}"))?;
  if entry.kind != "bundle" {
    return Err(format!("目标不是 Bundle: {bundle_path}"));
  }
  entry.changed = true;
  manifest.replacements.push(Replacement {
    kind: Some("bundle-node".to_string()),
    path: bundle_path,
    source_path,
    size,
    crc,
    replaced_at: shared::now_rfc3339(),
    node_id,
    node_path,
    resource_id,
  });
  write_manifest(work_dir, &manifest)?;
  Ok(manifest)
}

pub fn build(work_dir: &Path, output_apk: &Path) -> Result<BuildResult, String> {
  let manifest = load_manifest(work_dir)?;
  if let Some(parent) = output_apk.parent() {
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  let tmp = output_apk.with_extension("apk.tmp");
  let output = File::create(&tmp).map_err(|err| err.to_string())?;
  let mut writer = ZipWriter::new(output);

  for entry in &manifest.entries {
    if is_signature_file(&entry.path) {
      continue;
    }
    let mut header = zip::write::SimpleFileOptions::default().compression_method(compression_method_from_u16(entry.method));
    let path = if entry.is_dir && !entry.path.ends_with('/') {
      format!("{}/", entry.path)
    } else {
      entry.path.clone()
    };
    if entry.is_dir {
      writer.add_directory(path, header).map_err(|err| err.to_string())?;
      continue;
    }
    writer.start_file(path, header).map_err(|err| err.to_string())?;
    let source = work_dir.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !source.exists() {
      return Err(format!("构建失败，文件缺失: {}", entry.path));
    }
    shared::copy_file_to_writer(&source, &mut writer)?;
  }
  writer.finish().map_err(|err| err.to_string())?;
  fs::rename(tmp, output_apk).map_err(|err| err.to_string())?;

  Ok(BuildResult {
    output_apk: shared::must_abs(output_apk),
    signed: false,
    message: "已构建未签名 APK".to_string(),
  })
}

pub fn sign_debug(unsigned_apk: &Path, output_apk: &Path, keystore: &Path) -> Result<BuildResult, String> {
  let tools = tool_status_map();
  for name in ["keytool", "zipalign", "apksigner"] {
    if !tools.get(name).copied().unwrap_or(false) {
      return Err(format!("签名工具缺失: {name}"));
    }
  }
  if let Some(parent) = keystore.parent() {
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  if !keystore.exists() {
    let output = Command::new("keytool")
      .args([
        "-genkeypair",
        "-v",
        "-keystore",
        &keystore.to_string_lossy(),
        "-storepass",
        "android",
        "-keypass",
        "android",
        "-alias",
        "androiddebugkey",
        "-keyalg",
        "RSA",
        "-keysize",
        "2048",
        "-validity",
        "10000",
        "-dname",
        "CN=Android Debug,O=Android,C=US",
      ])
      .output()
      .map_err(|err| err.to_string())?;
    if !output.status.success() {
      return Err(format!("生成调试证书失败: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
  }
  let aligned = output_apk.with_extension("aligned-tmp.apk");
  let output = Command::new("zipalign")
    .args(["-f", "-p", "4", &unsigned_apk.to_string_lossy(), &aligned.to_string_lossy()])
    .output()
    .map_err(|err| err.to_string())?;
  if !output.status.success() {
    return Err(format!("zipalign 失败: {}", String::from_utf8_lossy(&output.stderr).trim()));
  }
  let sign_output = Command::new("apksigner")
    .args([
      "sign",
      "--ks",
      &keystore.to_string_lossy(),
      "--ks-key-alias",
      "androiddebugkey",
      "--ks-pass",
      "pass:android",
      "--key-pass",
      "pass:android",
      "--out",
      &output_apk.to_string_lossy(),
      &aligned.to_string_lossy(),
    ])
    .output()
    .map_err(|err| err.to_string())?;
  let _ = fs::remove_file(&aligned);
  if !sign_output.status.success() {
    return Err(format!("apksigner 失败: {}", String::from_utf8_lossy(&sign_output.stderr).trim()));
  }
  let verify_output = Command::new("apksigner")
    .args(["verify", &output_apk.to_string_lossy()])
    .output()
    .map_err(|err| err.to_string())?;
  if !verify_output.status.success() {
    return Err(format!("签名验证失败: {}", String::from_utf8_lossy(&verify_output.stderr).trim()));
  }
  Ok(BuildResult {
    output_apk: shared::must_abs(output_apk),
    signed: true,
    message: "已构建并调试签名".to_string(),
  })
}

pub fn tool_status() -> ToolStatus {
  let tools = tool_status_map();
  ToolStatus {
    summary: shared::format_tool_summary(&tools),
    tools,
  }
}

pub fn tool_status_map() -> BTreeMap<String, bool> {
  ["keytool", "zipalign", "apksigner", "apktool", "jadx"]
    .into_iter()
    .map(|name| (name.to_string(), shared::command_exists(name)))
    .collect()
}

pub fn is_signature_file(filename: &str) -> bool {
  let upper = filename.to_ascii_uppercase();
  if upper == "META-INF/MANIFEST.MF" {
    return true;
  }
  if !upper.starts_with("META-INF/") {
    return false;
  }
  let base = shared::path_base(&upper);
  SIGNATURE_SUFFIXES.iter().any(|suffix| base.ends_with(suffix))
}

fn compression_method_from_u16(value: u16) -> CompressionMethod {
  match value {
    0 => CompressionMethod::Stored,
    8 => CompressionMethod::Deflated,
    _ => CompressionMethod::Deflated,
  }
}

fn compression_method_to_u16(method: CompressionMethod) -> u16 {
  #[allow(deprecated)]
  match method {
    CompressionMethod::Stored => 0,
    CompressionMethod::Deflated => 8,
    CompressionMethod::Unsupported(value) => value,
    _ => 8,
  }
}

fn entry_from_zip(file: &ZipFile<'_>) -> Entry {
  let kind = classify(file.name());
  let replaceable = !file.is_dir() && !is_signature_file(file.name()) && kind != "dex" && kind != "native";
  Entry {
    path: file.name().to_string(),
    name: shared::path_base(file.name()),
    kind: kind.to_string(),
    size: file.size(),
    compressed: file.compressed_size(),
    crc: format!("{:08x}", file.crc32()),
    method: compression_method_to_u16(file.compression()),
    modified: Vec::new(),
    is_dir: file.is_dir(),
    changed: false,
    replaceable,
    external_attr: file.unix_mode().unwrap_or_default(),
    create_system: 0,
  }
}

fn classify(path: &str) -> &'static str {
  let lower = path.to_ascii_lowercase();
  if [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].iter().any(|ext| lower.ends_with(ext)) {
    "image"
  } else if [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].iter().any(|ext| lower.ends_with(ext)) {
    "audio"
  } else if [".json", ".xml", ".txt", ".lua", ".properties", ".cfg", ".ini", ".md"]
    .iter()
    .any(|ext| lower.ends_with(ext))
  {
    "text"
  } else if lower.ends_with(".bundle") {
    "bundle"
  } else if lower.ends_with(".dex") {
    "dex"
  } else if lower.ends_with(".so") {
    "native"
  } else if lower.ends_with(".arsc") {
    "android-resource"
  } else {
    "binary"
  }
}

fn count_names(names: &[String]) -> Counts {
  let mut counts = Counts {
    dex: 0,
    native_libs: 0,
    res: 0,
    assets: 0,
    unity_bundles: 0,
    unity_addressable_bundles: 0,
  };
  for name in names {
    if name.ends_with(".dex") {
      counts.dex += 1;
    }
    if name.starts_with("lib/") && name.ends_with(".so") {
      counts.native_libs += 1;
    }
    if name.starts_with("res/") {
      counts.res += 1;
    }
    if name.starts_with("assets/") {
      counts.assets += 1;
    }
    if name.ends_with(".bundle") {
      counts.unity_bundles += 1;
      if name.starts_with("assets/aa/Android/") {
        counts.unity_addressable_bundles += 1;
      }
    }
  }
  counts
}

fn detect_unity(names: &[String], addressables: bool) -> UnityInfo {
  let mut detected = false;
  let mut il2cpp = false;
  for name in names {
    if name == "assets/bin/Data/data.unity3d"
      || name == "assets/bin/Data/Managed/Metadata/global-metadata.dat"
      || name.ends_with("libunity.so")
      || name.ends_with(".bundle")
    {
      detected = true;
    }
    if name.ends_with("libil2cpp.so") {
      il2cpp = true;
    }
  }
  UnityInfo {
    detected,
    il2cpp,
    addressables,
  }
}

fn detect_signature(apk_path: &Path, names: &[String]) -> SignatureInfo {
  let mut files = names.iter().filter(|name| is_signature_file(name)).cloned().collect::<Vec<_>>();
  files.sort();
  SignatureInfo {
    v1_present: !files.is_empty(),
    apk_signing_block_present: has_apk_signing_block(apk_path),
    signature_files: files,
  }
}

fn has_apk_signing_block(apk_path: &Path) -> bool {
  let mut file = match File::open(apk_path) {
    Ok(file) => file,
    Err(_) => return false,
  };
  let size = match file.metadata() {
    Ok(meta) => meta.len(),
    Err(_) => return false,
  };
  let mut read_size = 65_557_u64;
  if size < read_size {
    read_size = size;
  }
  let mut tail = vec![0_u8; read_size as usize];
  if file.read_exact_at(&mut tail, size.saturating_sub(read_size)).is_err() {
    return false;
  }
  let eocd = tail.windows(4).rposition(|bytes| bytes == [0x50, 0x4b, 0x05, 0x06]);
  let Some(index) = eocd else {
    return false;
  };
  if index + 22 > tail.len() {
    return false;
  }
  let central_dir_offset = u32::from_le_bytes(tail[index + 16..index + 20].try_into().unwrap_or([0; 4])) as u64;
  if central_dir_offset < 24 {
    return false;
  }
  let mut footer = [0_u8; 24];
  if file.read_exact_at(&mut footer, central_dir_offset - 24).is_err() {
    return false;
  }
  footer[8..] == *APK_SIGN_BLOCK_MAGIC
}

fn parse_addressables(settings: Option<&Value>, catalog: Option<&Value>) -> AddressablesInfo {
  let mut out = AddressablesInfo::default();
  if let Some(Value::Object(map)) = settings {
    out.version = map.get("m_AddressablesVersion").and_then(Value::as_str).unwrap_or_default().to_string();
    out.build_target = map.get("m_buildTarget").and_then(Value::as_str).unwrap_or_default().to_string();
    out.settings_hash = map.get("m_SettingsHash").and_then(Value::as_str).unwrap_or_default().to_string();
    if let Some(Value::Array(locations)) = map.get("m_CatalogLocations") {
      out.catalog_count = locations.len();
    }
  }
  let mut resource_types = std::collections::BTreeSet::new();
  if let Some(Value::Object(map)) = catalog {
    if let Some(Value::Array(ids)) = map.get("m_InternalIds") {
      for value in ids {
        if let Some(id) = value.as_str() {
          if id.ends_with(".bundle") {
            out.bundle_count += 1;
            if out.bundle_samples.len() < 10 {
              out.bundle_samples.push(id.to_string());
            }
          }
        }
      }
    }
    if let Some(Value::Array(types)) = map.get("m_resourceTypes") {
      for value in types {
        if let Some(class_name) = value.get("m_ClassName").and_then(Value::as_str) {
          if !class_name.is_empty() {
            resource_types.insert(class_name.to_string());
          }
        }
      }
    }
  }
  out.resource_types = resource_types.into_iter().collect();
  out
}

fn read_zip_json(file: &mut ZipFile<'_>) -> Result<Value, String> {
  let mut text = String::new();
  file.read_to_string(&mut text).map_err(|err| err.to_string())?;
  serde_json::from_str(&text).map_err(|err| err.to_string())
}
