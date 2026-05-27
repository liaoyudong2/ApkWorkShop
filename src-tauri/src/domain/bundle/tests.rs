#[cfg(test)]
mod tests {
  use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
  };

  use zip::ZipArchive;

  use crate::domain::bundle::engine;

  #[test]
  fn extract_sample_code_bundle_has_resources() {
    let bundle = sample_bundle_by_name("assetsluascripts").expect("sample code bundle not found");
    let temp = temp_dir("bundle-code");
    let work_dir = temp.join("bundle");
    let manifest = engine::extract(&bundle, &work_dir, false).expect("extract code bundle");
    assert!(!manifest.resources.is_empty(), "expected serialized resources");
    assert!(
      manifest.resources.iter().any(|resource| resource.kind == "text"),
      "expected text resource, got {} resources",
      manifest.resources.len()
    );
  }

  #[test]
  fn extract_sample_image_bundle_has_resources() {
    let bundle = sample_bundle_by_name("bulletcomresbullettex").expect("sample image bundle not found");
    let temp = temp_dir("bundle-image");
    let work_dir = temp.join("bundle");
    let manifest = engine::extract(&bundle, &work_dir, false).expect("extract image bundle");
    assert!(
      manifest.resources.iter().any(|resource| resource.kind == "image"),
      "expected image resource, got {} resources",
      manifest.resources.len()
    );
  }

  #[test]
  fn extract_sample_audio_bundle_exports_wav() {
    let bundle = sample_bundle_by_name("audiossound").expect("sample audio bundle not found");
    let temp = temp_dir("bundle-audio");
    let work_dir = temp.join("bundle");
    let manifest = engine::extract(&bundle, &work_dir, false).expect("extract audio bundle");
    let resource = manifest
      .resources
      .iter()
      .find(|resource| resource.kind == "audio" && resource.file_name.ends_with(".wav"))
      .expect("expected wav audio resource");
    let node = manifest
      .nodes
      .iter()
      .find(|node| node.id == resource.node_id)
      .expect("resource node");
    let bytes = fs::read(work_dir.join("resources").join(&resource.file_name)).expect("read wav");
    assert!(bytes.starts_with(b"RIFF"), "expected wav header");
    assert!(
      resource.details.as_deref().unwrap_or_default().contains("audio_frequency"),
      "expected audio details"
    );
    assert_eq!(node.kind, "binary");
  }

  #[test]
  fn load_manifest_refreshes_legacy_audio_exports() {
    let bundle = sample_bundle_by_name("audiossound").expect("sample audio bundle not found");
    let temp = temp_dir("bundle-audio-refresh");
    let work_dir = temp.join("bundle");
    let manifest = engine::extract(&bundle, &work_dir, false).expect("extract audio bundle");
    let original = manifest
      .resources
      .iter()
      .find(|resource| resource.kind == "audio" && resource.file_name.ends_with(".wav"))
      .cloned()
      .expect("expected wav audio resource");

    let mut legacy = manifest.clone();
    legacy.schema_version = 1;
    let resource = legacy
      .resources
      .iter_mut()
      .find(|resource| resource.id == original.id)
      .expect("audio resource exists");
    let legacy_name = resource.file_name.replace(".wav", ".audio.meta.txt");
    fs::rename(
      work_dir.join("resources").join(&resource.file_name),
      work_dir.join("resources").join(&legacy_name),
    )
    .expect("rename wav to legacy meta");
    resource.file_name = legacy_name;
    resource.details = Some("legacy audio export".to_string());
    engine::write_manifest(&work_dir, &legacy).expect("write legacy manifest");

    let refreshed = engine::load_manifest(&work_dir).expect("refresh manifest");
    let refreshed_resource = refreshed
      .resources
      .iter()
      .find(|resource| resource.id == original.id)
      .expect("refreshed resource");
    assert!(refreshed_resource.file_name.ends_with(".wav"));
    let bytes = fs::read(work_dir.join("resources").join(&refreshed_resource.file_name)).expect("read refreshed wav");
    assert!(bytes.starts_with(b"RIFF"));
    assert_eq!(refreshed.schema_version, 2);
  }

  fn sample_bundle_by_name(contains: &str) -> Option<PathBuf> {
    let apk_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("apk");
    let apk_path = fs::read_dir(apk_dir)
      .ok()?
      .filter_map(Result::ok)
      .map(|entry| entry.path())
      .find(|path| path.extension().map(|ext| ext.eq_ignore_ascii_case("apk")).unwrap_or(false))?;

    let file = File::open(apk_path).ok()?;
    let mut zip = ZipArchive::new(file).ok()?;
    let temp = temp_dir("bundle-sample");
    for index in 0..zip.len() {
      let mut entry = zip.by_index(index).ok()?;
      let name = entry.name().to_string();
      if !name.ends_with(".bundle") || !name.contains(contains) {
        continue;
      }
      let out = temp.join(
        Path::new(&name)
          .file_name()
          .and_then(|value| value.to_str())
          .unwrap_or("sample.bundle"),
      );
      let mut bytes = Vec::new();
      entry.read_to_end(&mut bytes).ok()?;
      let mut file = File::create(&out).ok()?;
      file.write_all(&bytes).ok()?;
      return Some(out);
    }
    None
  }

  fn temp_dir(prefix: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("apkworkshop-{prefix}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create temp dir");
    path
  }
}
