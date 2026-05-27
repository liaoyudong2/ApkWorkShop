use std::{fs, path::Path};

use serde_json::Value;

use crate::{
  application::models::{BundleNode, BundleResource, Entry, PreviewResult, ScanReport},
  support::shared,
};

const MAX_TEXT_BYTES: usize = 256 * 1024;
pub fn preview_apk_entry(work_dir: &Path, entry: &Entry, scan: &ScanReport) -> Result<PreviewResult, String> {
  let full_path = work_dir.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR));
  match entry.kind.as_str() {
    "image" => image_preview(&full_path, entry.name.clone(), Some(build_entry_summary(entry)?)),
    "audio" => audio_preview(&full_path, entry.name.clone(), Some(build_entry_summary(entry)?)),
    "text" => text_preview(&full_path, entry.name.clone()),
    "bundle" => Ok(bundle_summary(entry, scan)),
    _ => structured_only_preview(entry.name.clone(), Some(build_entry_summary(entry)?), Some(shared::must_abs(full_path))),
  }
}

pub fn preview_bundle_node(bundle_work_dir: &Path, node: &BundleNode) -> Result<PreviewResult, String> {
  let path = bundle_work_dir.join("files").join(&node.file_name);
  match node.kind.as_str() {
    "image" => image_preview(&path, node.name.clone(), Some(bundle_node_meta(node))),
    "text" => text_preview_with_title(&path, node.name.clone()),
    _ => structured_only_preview(node.name.clone(), Some(bundle_node_meta(node)), Some(shared::must_abs(path))),
  }
}

pub fn preview_bundle_resource(bundle_work_dir: &Path, resource: &BundleResource) -> Result<PreviewResult, String> {
  let path = bundle_work_dir.join("resources").join(&resource.file_name);
  let meta = bundle_resource_meta(resource);
  match resource.kind.as_str() {
    "image" if path.extension().and_then(|value| value.to_str()).map(|ext| ext.eq_ignore_ascii_case("png")).unwrap_or(false) => {
      image_preview(&path, resource.name.clone(), Some(meta))
    }
    "text" => {
      let mut result = text_preview_with_title(&path, resource.name.clone())?;
      result.summary = Some(meta);
      Ok(result)
    }
    "audio"
      if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac"))
        .unwrap_or(false) => audio_preview(&path, resource.name.clone(), Some(meta)),
    _ => structured_only_preview(resource.name.clone(), Some(meta), Some(shared::must_abs(path))),
  }
}

fn image_preview(path: &Path, title: String, summary: Option<String>) -> Result<PreviewResult, String> {
  let mime = image_mime(path);
  Ok(PreviewResult {
    mode: "image".to_string(),
    title,
    text: None,
    summary,
    image_data_url: Some(shared::file_to_data_url(path, mime)?),
    audio_data_url: None,
    file_path: Some(shared::must_abs(path)),
  })
}

fn audio_preview(path: &Path, title: String, summary: Option<String>) -> Result<PreviewResult, String> {
  let mime = audio_mime(path);
  Ok(PreviewResult {
    mode: "audio".to_string(),
    title,
    text: None,
    summary,
    image_data_url: None,
    audio_data_url: Some(shared::file_to_data_url(path, mime)?),
    file_path: Some(shared::must_abs(path)),
  })
}

fn text_preview(path: &Path, title: String) -> Result<PreviewResult, String> {
  text_preview_with_title(path, title)
}

fn text_preview_with_title(path: &Path, title: String) -> Result<PreviewResult, String> {
  let bytes = fs::read(path).map_err(|err| err.to_string())?;
  let mut text = if path.extension().and_then(|value| value.to_str()).map(|ext| ext.eq_ignore_ascii_case("json")).unwrap_or(false) {
    pretty_json_bytes(&bytes).unwrap_or_else(|| data_preview_text(&bytes))
  } else {
    data_preview_text(&bytes)
  };
  if bytes.len() > MAX_TEXT_BYTES {
    text.push_str("\n\n... 内容过长，仅显示前 256KB ...");
  }
  Ok(PreviewResult {
    mode: "text".to_string(),
    title,
    text: Some(text),
    summary: None,
    image_data_url: None,
    audio_data_url: None,
    file_path: Some(shared::must_abs(path)),
  })
}

fn structured_only_preview(title: String, summary: Option<String>, file_path: Option<String>) -> Result<PreviewResult, String> {
  Ok(PreviewResult {
    mode: "binary".to_string(),
    title,
    text: None,
    summary,
    image_data_url: None,
    audio_data_url: None,
    file_path,
  })
}

fn bundle_summary(entry: &Entry, scan: &ScanReport) -> PreviewResult {
  PreviewResult {
    mode: "bundle".to_string(),
    title: entry.name.clone(),
    text: None,
    summary: Some(format!(
      "Unity Bundle\n路径: {}\n大小: {} bytes\nCRC: {}\nAddressables: {}\nBundle 总数: {}\n\n首版支持整 Bundle 文件替换、节点解包与 TextAsset 替换。",
      entry.path,
      entry.size,
      entry.crc,
      empty_dash(&scan.addressables.version),
      scan.counts.unity_bundles,
    )),
    image_data_url: None,
    audio_data_url: None,
    file_path: None,
  }
}

fn build_entry_summary(entry: &Entry) -> Result<String, String> {
  Ok(format!(
    "路径: {}\n类型: {}\n大小: {} bytes\nCRC: {}\n压缩方式: {}",
    entry.path, entry.kind, entry.size, entry.crc, entry.method
  ))
}

fn bundle_node_meta(node: &BundleNode) -> String {
  format!(
    "路径: {}\n类型: {} | 大小: {} bytes | CRC: {} | 已替换: {}",
    node.path,
    node.kind,
    node.size,
    empty_dash(node.crc.as_deref().unwrap_or("")),
    if node.changed { "是" } else { "否" },
  )
}

fn bundle_resource_meta(resource: &BundleResource) -> String {
  format!(
    "名称: {}\nUnity 类型: {} | 预览类型: {} | ClassID: {} | PathID: {}\n节点: {}\n导出文件: {} | 大小: {} bytes | CRC: {} | 可替换: {} | 已替换: {}{}",
    empty_dash(&resource.name),
    resource.r#type,
    resource.kind,
    resource.class_id,
    resource.path_id,
    empty_dash(&resource.node_path),
    empty_dash(&resource.file_name),
    resource.size,
    empty_dash(resource.crc.as_deref().unwrap_or("")),
    if resource.replaceable { "是" } else { "否" },
    if resource.changed { "是" } else { "否" },
    resource
      .details
      .as_ref()
      .filter(|value| !value.trim().is_empty())
      .map(|value| format!("\n\n{value}"))
      .unwrap_or_default()
  )
}

fn image_mime(path: &Path) -> &'static str {
  match path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "bmp" => "image/bmp",
    _ => "image/png",
  }
}

fn audio_mime(path: &Path) -> &'static str {
  match path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
    "mp3" => "audio/mpeg",
    "wav" => "audio/wav",
    "ogg" => "audio/ogg",
    "m4a" => "audio/mp4",
    "aac" => "audio/aac",
    "flac" => "audio/flac",
    _ => "audio/*",
  }
}

fn pretty_json_bytes(bytes: &[u8]) -> Option<String> {
  let slice = if bytes.len() > MAX_TEXT_BYTES { &bytes[..MAX_TEXT_BYTES] } else { bytes };
  let value: Value = serde_json::from_slice(slice).ok()?;
  serde_json::to_string_pretty(&value).ok()
}

fn data_preview_text(bytes: &[u8]) -> String {
  let slice = if bytes.len() > MAX_TEXT_BYTES { &bytes[..MAX_TEXT_BYTES] } else { bytes };
  String::from_utf8_lossy(slice).to_string()
}

fn empty_dash(value: &str) -> &str {
  if value.is_empty() {
    "-"
  } else {
    value
  }
}
