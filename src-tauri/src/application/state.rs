use std::{
  path::{Path, PathBuf},
  sync::Mutex,
};

use tauri::{AppHandle, Manager};

use crate::{
  application::models::{ActivityLogItem, BundleManifest, ProjectStateDto},
  support::shared,
};

pub struct AppState {
  pub app: AppHandle,
  pub current: Mutex<Option<ProjectRuntime>>,
}

#[derive(Debug, Clone)]
pub struct ProjectRuntime {
  pub apk_path: PathBuf,
  pub work_dir: PathBuf,
  pub dist_dir: PathBuf,
  pub dto: ProjectStateDto,
  pub bundle_manifests: std::collections::BTreeMap<String, BundleManifest>,
  pub activity_logs: Vec<ActivityLogItem>,
}

impl AppState {
  pub fn new(app: AppHandle) -> Self {
    Self {
      app,
      current: Mutex::new(None),
    }
  }

  pub fn workspace_root(&self) -> Result<PathBuf, String> {
    shared::resolve_workspace_root(self.app.path().resolve("..", tauri::path::BaseDirectory::Resource))
  }

  pub fn storage_root(&self) -> Result<PathBuf, String> {
    shared::resolve_storage_root(self.app.path().app_local_data_dir())
  }

  pub fn default_apk(&self) -> Result<Option<PathBuf>, String> {
    let root = self.workspace_root()?;
    let apk_dir = root.join("apk");
    if !apk_dir.exists() {
      return Ok(None);
    }
    let mut matches = std::fs::read_dir(&apk_dir)
      .map_err(|err| err.to_string())?
      .filter_map(Result::ok)
      .map(|entry| entry.path())
      .filter(|path| path.extension().map(|ext| ext.eq_ignore_ascii_case("apk")).unwrap_or(false))
      .collect::<Vec<_>>();
    matches.sort();
    Ok(matches.into_iter().next())
  }

  pub fn work_dir_for(&self, apk_path: &Path) -> Result<PathBuf, String> {
    let root = self.storage_root()?;
    let stem = apk_path
      .file_stem()
      .and_then(|value| value.to_str())
      .ok_or_else(|| "APK 文件名无效".to_string())?;
    Ok(root.join("work").join(stem))
  }

  pub fn dist_dir(&self) -> Result<PathBuf, String> {
    Ok(self.storage_root()?.join("dist"))
  }
}
