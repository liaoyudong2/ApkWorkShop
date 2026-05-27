use std::{
  fs::{self, File},
  io::{self, Read, Write},
  path::{Path, PathBuf},
  process::Command,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;

pub fn now_rfc3339() -> String {
  Utc::now().to_rfc3339()
}

pub fn must_abs(path: impl AsRef<Path>) -> String {
  fs::canonicalize(path.as_ref())
    .unwrap_or_else(|_| path.as_ref().to_path_buf())
    .to_string_lossy()
    .to_string()
}

pub fn path_base(path: &str) -> String {
  Path::new(path)
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or(path)
    .to_string()
}

pub fn validate_apk_path(name: &str) -> Result<String, String> {
  let normalized = name.replace('\\', "/");
  if normalized.is_empty() || normalized.starts_with('/') || normalized.starts_with("../") {
    return Err(format!("非法 APK 路径: {name}"));
  }
  for part in normalized.split('/') {
    if part == ".." {
      return Err(format!("非法 APK 路径: {name}"));
    }
  }
  Ok(normalized)
}

pub fn dir_is_empty(path: &Path) -> Result<bool, String> {
  let mut entries = fs::read_dir(path).map_err(|err| err.to_string())?;
  Ok(entries.next().is_none())
}

pub fn copy_file(src: &Path, dest: &Path) -> Result<(), String> {
  let mut input = File::open(src).map_err(|err| err.to_string())?;
  if let Some(parent) = dest.parent() {
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  let mut output = File::create(dest).map_err(|err| err.to_string())?;
  io::copy(&mut input, &mut output).map_err(|err| err.to_string())?;
  Ok(())
}

pub fn copy_file_to_writer(src: &Path, writer: &mut dyn Write) -> Result<(), String> {
  let mut input = File::open(src).map_err(|err| err.to_string())?;
  io::copy(&mut input, writer).map_err(|err| err.to_string())?;
  Ok(())
}

pub fn file_crc(path: &Path) -> Result<(u64, String), String> {
  let mut file = File::open(path).map_err(|err| err.to_string())?;
  let mut hasher = crc32fast::Hasher::new();
  let mut buf = [0_u8; 64 * 1024];
  let mut size = 0_u64;
  loop {
    let read = file.read(&mut buf).map_err(|err| err.to_string())?;
    if read == 0 {
      break;
    }
    hasher.update(&buf[..read]);
    size += read as u64;
  }
  Ok((size, format!("{:08x}", hasher.finalize())))
}

pub fn write_json_file<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
  }
  let mut data = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
  data.push(b'\n');
  fs::write(path, data).map_err(|err| err.to_string())
}

pub fn read_json_file<T: for<'de> serde::Deserialize<'de>>(path: &Path) -> Result<T, String> {
  let data = fs::read(path).map_err(|err| err.to_string())?;
  serde_json::from_slice(&data).map_err(|err| err.to_string())
}

pub fn command_exists(name: &str) -> bool {
  Command::new(name)
    .arg("--version")
    .output()
    .map(|output| output.status.success())
    .unwrap_or(false)
}

pub fn file_to_data_url(path: &Path, mime: &str) -> Result<String, String> {
  let bytes = fs::read(path).map_err(|err| err.to_string())?;
  Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

pub fn bytes_to_data_url(bytes: &[u8], mime: &str) -> String {
  format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

pub fn read_preview_text(path: &Path, max_bytes: usize) -> Result<String, String> {
  let mut file = File::open(path).map_err(|err| err.to_string())?;
  let mut buf = vec![0_u8; max_bytes];
  let read = file.read(&mut buf).map_err(|err| err.to_string())?;
  Ok(String::from_utf8_lossy(&buf[..read]).to_string())
}

pub fn format_tool_summary(tools: &std::collections::BTreeMap<String, bool>) -> String {
  let mut parts = Vec::new();
  for name in ["keytool", "zipalign", "apksigner", "apktool", "jadx"] {
    let state = if *tools.get(name).unwrap_or(&false) { "有" } else { "无" };
    parts.push(format!("{name}:{state}"));
  }
  if !tools.get("zipalign").copied().unwrap_or(false) || !tools.get("apksigner").copied().unwrap_or(false) {
    parts.push("签名不可用，可构建未签名 APK".to_string());
  }
  parts.join("  ")
}

pub fn resolve_workspace_root(app_root_hint: Result<PathBuf, tauri::Error>) -> Result<PathBuf, String> {
  if let Ok(root) = app_root_hint {
    if root.join("apk").exists() {
      return Ok(root);
    }
  }
  std::env::current_dir().map_err(|err| err.to_string())
}

pub fn resolve_storage_root(app_data_dir: Result<PathBuf, tauri::Error>) -> Result<PathBuf, String> {
  let root = match app_data_dir {
    Ok(path) => path.join("workspace"),
    Err(_) => std::env::current_dir()
      .map_err(|err| err.to_string())?
      .join(".apkworkshop-data"),
  };
  fs::create_dir_all(&root).map_err(|err| err.to_string())?;
  Ok(root)
}
