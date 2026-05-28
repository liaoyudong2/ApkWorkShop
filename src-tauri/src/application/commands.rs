use std::{
  path::{Path, PathBuf},
};

use sha1::Digest;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;

use crate::{
  application::{
    models::{
      ActivityLogItem, BuildResult, BundleInfo, BundleManifest, BundleResourceCounts, BundleResourceSummary, Manifest,
      PreviewResult, ProjectStateDto, ToolStatus, WorkProgressEvent,
    },
    state::{AppState, ProjectRuntime},
  },
  domain::{
    apk::engine as apk,
    bundle::{engine as bundle, serialized},
    preview,
  },
  support::shared,
};

#[tauri::command]
pub async fn bootstrap_project(app: AppHandle) -> Result<Option<ProjectStateDto>, String> {
  run_blocking(app, |app| {
    let state = app.state::<AppState>();
    if let Some(current) = state.current.lock().map_err(|_| "状态锁失败".to_string())?.clone() {
      return Ok(Some(current.dto));
    }
    let root = state.workspace_root()?;
    let Some(apk_path) = apk::default_apk(&root) else {
      return Ok(None);
    };
    let runtime = build_runtime(&state, apk_path)?;
    let dto = runtime.dto.clone();
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(runtime);
    Ok(Some(dto))
  })
  .await
}

#[tauri::command]
pub async fn scan_project(app: AppHandle, apk_path: Option<String>) -> Result<Option<ProjectStateDto>, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let root = state.workspace_root()?;
    let apk_path = match apk_path {
      Some(path) if !path.trim().is_empty() => PathBuf::from(path),
      _ => match apk::default_apk(&root) {
        Some(path) => path,
        None => return Ok(None),
      },
    };
    let runtime = build_runtime(&state, apk_path)?;
    let dto = runtime.dto.clone();
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(runtime);
    Ok(Some(dto))
  })
  .await
}

#[tauri::command]
pub async fn choose_apk(app: AppHandle) -> Result<Option<String>, String> {
  let (tx, rx) = std::sync::mpsc::channel();
  app.dialog().file().add_filter("APK", &["apk"]).pick_file(move |selected| {
    let _ = tx.send(selected.and_then(file_path_to_string));
  });
  tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn choose_replacement_file(app: AppHandle) -> Result<Option<String>, String> {
  let (tx, rx) = std::sync::mpsc::channel();
  app.dialog().file().pick_file(move |selected| {
    let _ = tx.send(selected.and_then(file_path_to_string));
  });
  tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn extract_project(app: AppHandle, force: bool) -> Result<ProjectStateDto, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    emit_work_progress(&app, "extract-apk", 0, 0, "", None, false)?;
    let manifest = apk::extract_with_progress(&current.apk_path, &current.work_dir, force, |current_index, total, path| {
      emit_work_progress(&app, "extract-apk", current_index, total, path, Some(path.to_string()), false)
    })?;
    emit_work_progress(&app, "extract-apk", manifest.entries.len(), manifest.entries.len(), "", None, true)?;
    current.dto.manifest = Some(manifest);
    current.bundle_manifests.clear();
    let work_dir = current.work_dir.display().to_string();
    append_log(&mut current, "info", format!("APK 解包完成：{work_dir}"));
    let dto = current.dto.clone();
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(dto)
  })
  .await
}

#[tauri::command]
pub async fn load_manifest(app: AppHandle) -> Result<Manifest, String> {
  run_blocking(app, |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let manifest = apk::load_manifest(&current.work_dir)?;
    current.dto.manifest = Some(manifest.clone());
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(manifest)
  })
  .await
}

#[tauri::command]
pub async fn replace_apk_entry(
  app: AppHandle,
  target_path: String,
  source_path: String,
) -> Result<ProjectStateDto, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let source = PathBuf::from(&source_path);
    let (_record, manifest) = apk::replace(&current.work_dir, &target_path, &source)?;
    if target_path.to_ascii_lowercase().ends_with(".bundle") {
      current.bundle_manifests.remove(&target_path);
      let bundle_dir = bundle_work_dir(&current.work_dir, &target_path);
      let _ = std::fs::remove_dir_all(bundle_dir);
    }
    current.dto.manifest = Some(manifest);
    append_log(&mut current, "info", format!("已替换 APK 文件：{target_path} <- {}", source.display()));
    let dto = current.dto.clone();
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(dto)
  })
  .await
}

#[tauri::command]
pub async fn build_apk(app: AppHandle) -> Result<BuildResult, String> {
  run_blocking(app, |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let name = current
      .apk_path
      .file_stem()
      .and_then(|value| value.to_str())
      .ok_or_else(|| "APK 文件名无效".to_string())?;
    let output = current.dist_dir.join(format!("{name}-unsigned.apk"));
    let result = apk::build(&current.work_dir, &output)?;
    append_log(&mut current, "info", format!("APK 构建完成：{}", result.output_apk));
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(result)
  })
  .await
}

#[tauri::command]
pub async fn sign_apk(app: AppHandle, unsigned_apk: Option<String>) -> Result<BuildResult, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let name = current
      .apk_path
      .file_stem()
      .and_then(|value| value.to_str())
      .ok_or_else(|| "APK 文件名无效".to_string())?;
    let unsigned = unsigned_apk
      .map(PathBuf::from)
      .unwrap_or_else(|| current.dist_dir.join(format!("{name}-unsigned.apk")));
    let signed = current.dist_dir.join(format!("{name}-debug.apk"));
    let root = current
      .work_dir
      .parent()
      .and_then(|value| value.parent())
      .map(Path::to_path_buf)
      .unwrap_or_else(|| current.work_dir.clone());
    let keystore = root.join(".apkworkshop").join("debug.keystore");
    let result = apk::sign_debug(&unsigned, &signed, &keystore)?;
    append_log(&mut current, "info", format!("APK 调试签名完成：{}", result.output_apk));
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(result)
  })
  .await
}

#[tauri::command]
pub fn tool_status(_app: AppHandle) -> Result<ToolStatus, String> {
  Ok(apk::tool_status())
}

#[tauri::command]
pub async fn analyze_bundle(app: AppHandle, bundle_path: String) -> Result<BundleInfo, String> {
  run_blocking(app, move |app| {
    let current = current_runtime_from_app(&app)?;
    bundle::analyze(&current.work_dir.join(bundle_path.replace('/', std::path::MAIN_SEPARATOR_STR)))
  })
  .await
}

#[tauri::command]
pub async fn extract_bundle(app: AppHandle, bundle_path: String, force: bool) -> Result<BundleManifest, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let bundle_full_path = current.work_dir.join(bundle_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let work_dir = bundle_work_dir(&current.work_dir, &bundle_path);
    let manifest = bundle::extract(&bundle_full_path, &work_dir, force)?;
    current.bundle_manifests.insert(bundle_path.clone(), manifest.clone());
    append_log(&mut current, "info", format!("Bundle 解包完成：{bundle_path}"));
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(manifest)
  })
  .await
}

#[tauri::command]
pub async fn extract_all_bundles(app: AppHandle, force: bool) -> Result<Vec<BundleManifest>, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let manifest = current
      .dto
      .manifest
      .clone()
      .ok_or_else(|| "当前尚未解包 APK".to_string())?;
    let bundle_paths = manifest
      .entries
      .into_iter()
      .filter(|entry| !entry.is_dir && entry.kind == "bundle")
      .map(|entry| entry.path)
      .collect::<Vec<_>>();

    let total = bundle_paths.len();
    emit_work_progress(&app, "extract-all-bundles", 0, total, "", None, false)?;
    let mut out = Vec::with_capacity(total);
    let mut failures = Vec::new();
    for (index, bundle_path) in bundle_paths.into_iter().enumerate() {
      match bundle::extract(
        &current.work_dir.join(bundle_path.replace('/', std::path::MAIN_SEPARATOR_STR)),
        &bundle_work_dir(&current.work_dir, &bundle_path),
        force,
      ) {
        Ok(manifest) => {
          current.bundle_manifests.insert(bundle_path.clone(), manifest.clone());
          out.push(manifest);
        }
        Err(err) => {
          failures.push((bundle_path.clone(), err));
        }
      }
      let _ = emit_work_progress(
        &app,
        "extract-all-bundles",
        index + 1,
        total,
        &bundle_path,
        Some(bundle_path.clone()),
        false,
      );
    }
    let _ = emit_work_progress(&app, "extract-all-bundles", out.len() + failures.len(), total, "", None, true);
    append_log(
      &mut current,
      if failures.is_empty() { "info" } else { "warn" },
      format!("全部 Bundle 解包完成：成功 {} 个，失败 {} 个。", out.len(), failures.len()),
    );
    for (bundle_path, err) in failures.iter().take(5) {
      append_log(&mut current, "warn", format!("Bundle 解包失败：{bundle_path} -> {err}"));
    }
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    if out.is_empty() && !failures.is_empty() {
      return Err(format!(
        "全部 Bundle 解包失败，共 {} 个。首个错误：{} -> {}",
        failures.len(),
        failures[0].0,
        failures[0].1
      ));
    }
    Ok(out)
  })
  .await
}

#[tauri::command]
pub async fn load_bundle_manifest(app: AppHandle, bundle_path: String) -> Result<BundleManifest, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let manifest = load_bundle_manifest_into_runtime(&mut current, &bundle_path)?;
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(manifest)
  })
  .await
}

#[tauri::command]
pub async fn replace_bundle_node(
  app: AppHandle,
  bundle_path: String,
  node_id: String,
  source_path: String,
) -> Result<BundleManifest, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let source = PathBuf::from(&source_path);
    let bundle_dir = bundle_work_dir(&current.work_dir, &bundle_path);
    let (record, manifest) = bundle::replace_node(&bundle_dir, &node_id, &source)?;
    let apk_manifest = apk::mark_bundle_replacement(
      &current.work_dir,
      &bundle_path,
      record.node_id.clone(),
      record.node_path.clone(),
      None,
      record.source_path.clone(),
      record.size,
      record.crc.clone(),
    )?;
    current.dto.manifest = Some(apk_manifest);
    current.bundle_manifests.insert(bundle_path.clone(), manifest.clone());
    append_log(&mut current, "info", format!("Bundle 节点已替换：{bundle_path} -> {node_id}"));
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(manifest)
  })
  .await
}

#[tauri::command]
pub async fn replace_bundle_resource(
  app: AppHandle,
  bundle_path: String,
  resource_id: String,
  source_path: String,
) -> Result<BundleManifest, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let source = PathBuf::from(&source_path);
    let bundle_dir = bundle_work_dir(&current.work_dir, &bundle_path);
    let (record, manifest) = bundle::replace_resource(&bundle_dir, &resource_id, &source)?;
    let apk_manifest = apk::mark_bundle_replacement(
      &current.work_dir,
      &bundle_path,
      record.node_id.clone(),
      record.node_path.clone(),
      record.resource_id.clone(),
      record.source_path.clone(),
      record.size,
      record.crc.clone(),
    )?;
    current.dto.manifest = Some(apk_manifest);
    current.bundle_manifests.insert(bundle_path.clone(), manifest.clone());
    append_log(&mut current, "info", format!("Bundle 资源已替换：{bundle_path} -> {resource_id}"));
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(manifest)
  })
  .await
}

#[tauri::command]
pub async fn build_bundle(app: AppHandle, bundle_path: String) -> Result<BundleManifest, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let bundle_dir = bundle_work_dir(&current.work_dir, &bundle_path);
    let output = current.work_dir.join(bundle_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    bundle::build(&bundle_dir, &output)?;
    let manifest = load_bundle_manifest_into_runtime(&mut current, &bundle_path)?;
    append_log(&mut current, "info", format!("Bundle 封包完成并写回工作区：{bundle_path}"));
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(manifest)
  })
  .await
}

#[tauri::command]
pub async fn preview_apk_entry(app: AppHandle, target_path: String) -> Result<PreviewResult, String> {
  run_blocking(app, move |app| {
    let current = current_runtime_from_app(&app)?;
    let manifest = current
      .dto
      .manifest
      .clone()
      .ok_or_else(|| "当前尚未解包 APK".to_string())?;
    let entry = manifest
      .entries
      .iter()
      .find(|entry| entry.path == target_path)
      .ok_or_else(|| format!("APK 条目不存在: {target_path}"))?;
    preview::preview_apk_entry(&current.work_dir, entry, &current.dto.scan)
  })
  .await
}

#[tauri::command]
pub async fn preview_bundle_node(
  app: AppHandle,
  bundle_path: String,
  node_id: String,
) -> Result<PreviewResult, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let manifest = load_bundle_manifest_into_runtime(&mut current, &bundle_path)?;
    let node = manifest
      .nodes
      .iter()
      .find(|node| node.id == node_id)
      .ok_or_else(|| format!("Bundle 节点不存在: {node_id}"))?;
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current.clone());
    preview::preview_bundle_node(&bundle_work_dir(&current.work_dir, &bundle_path), node)
  })
  .await
}

#[tauri::command]
pub async fn preview_bundle_resource(
  app: AppHandle,
  bundle_path: String,
  resource_id: String,
) -> Result<PreviewResult, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let manifest = load_bundle_manifest_into_runtime(&mut current, &bundle_path)?;
    let resource = manifest
      .resources
      .iter()
      .find(|resource| resource.id == resource_id)
      .ok_or_else(|| format!("Bundle 资源不存在: {resource_id}"))?;
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current.clone());
    preview::preview_bundle_resource(&bundle_work_dir(&current.work_dir, &bundle_path), resource)
  })
  .await
}

#[tauri::command]
pub async fn list_bundle_resources(
  app: AppHandle,
  group: Option<String>,
  query: Option<String>,
) -> Result<Vec<BundleResourceSummary>, String> {
  run_blocking(app, move |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let items = collect_bundle_resources(&mut current, group.as_deref(), query.as_deref())?;
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(items)
  })
  .await
}

#[tauri::command]
pub async fn bundle_resource_counts(app: AppHandle) -> Result<BundleResourceCounts, String> {
  run_blocking(app, |app| {
    let state = app.state::<AppState>();
    let mut current = current_runtime_from_app(&app)?;
    let counts = collect_bundle_resource_counts(&mut current)?;
    *state.current.lock().map_err(|_| "状态锁失败".to_string())? = Some(current);
    Ok(counts)
  })
  .await
}

#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
  app
    .opener()
    .open_path(path, None::<String>)
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn activity_logs(state: State<'_, AppState>) -> Result<Vec<ActivityLogItem>, String> {
  Ok(current_runtime(&state)?.activity_logs)
}

async fn run_blocking<T, F>(app: AppHandle, task: F) -> Result<T, String>
where
  T: Send + 'static,
  F: FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
{
  tauri::async_runtime::spawn_blocking(move || task(app))
    .await
    .map_err(|err| err.to_string())?
}

fn build_runtime(state: &AppState, apk_path: PathBuf) -> Result<ProjectRuntime, String> {
  let scan = apk::scan(&apk_path)?;
  let scan_name = scan.name.clone();
  let work_dir = state.work_dir_for(&apk_path)?;
  let dist_dir = state.dist_dir()?;
  let manifest = if work_dir.join(apk::MANIFEST_NAME).exists() {
    Some(apk::load_manifest(&work_dir)?)
  } else {
    None
  };
  let mut runtime = ProjectRuntime {
    apk_path,
    work_dir: work_dir.clone(),
    dist_dir: dist_dir.clone(),
    dto: ProjectStateDto {
      scan,
      manifest,
      work_dir: work_dir.to_string_lossy().to_string(),
      dist_dir: dist_dir.to_string_lossy().to_string(),
    },
    bundle_manifests: Default::default(),
    activity_logs: Vec::new(),
  };
  append_log(&mut runtime, "info", format!("已扫描 APK：{scan_name}"));
  Ok(runtime)
}

fn current_runtime(state: &State<'_, AppState>) -> Result<ProjectRuntime, String> {
  state
    .current
    .lock()
    .map_err(|_| "状态锁失败".to_string())?
    .clone()
    .ok_or_else(|| "当前没有已扫描的 APK".to_string())
}

fn current_runtime_from_app(app: &AppHandle) -> Result<ProjectRuntime, String> {
  app
    .state::<AppState>()
    .current
    .lock()
    .map_err(|_| "状态锁失败".to_string())?
    .clone()
    .ok_or_else(|| "当前没有已扫描的 APK".to_string())
}

fn load_bundle_manifest_into_runtime(current: &mut ProjectRuntime, bundle_path: &str) -> Result<BundleManifest, String> {
  if let Some(manifest) = current.bundle_manifests.get(bundle_path) {
    return Ok(manifest.clone());
  }
  let manifest = bundle::load_manifest(&bundle_work_dir(&current.work_dir, bundle_path))?;
  current.bundle_manifests.insert(bundle_path.to_string(), manifest.clone());
  Ok(manifest)
}

fn collect_bundle_resources(
  current: &mut ProjectRuntime,
  group: Option<&str>,
  query: Option<&str>,
) -> Result<Vec<BundleResourceSummary>, String> {
  let manifest = current
    .dto
    .manifest
    .clone()
    .ok_or_else(|| "当前尚未解包 APK".to_string())?;
  let group = group.unwrap_or_default();
  let query = query.unwrap_or_default().to_lowercase();

  let mut items = Vec::new();
  for entry in manifest.entries.into_iter().filter(|entry| !entry.is_dir && entry.kind == "bundle") {
    let bundle_manifest = match load_bundle_manifest_into_runtime(current, &entry.path) {
      Ok(value) => value,
      Err(_) => continue,
    };
    for resource in bundle_manifest.resources {
      let kind = serialized::classify_bundle_resource_kind(&resource.kind);
      if !group.is_empty() && kind != group {
        continue;
      }
      if !query.is_empty() {
        let hit = [
          entry.path.as_str(),
          resource.id.as_str(),
          resource.name.as_str(),
          resource.r#type.as_str(),
          resource.file_name.as_str(),
          resource.node_path.as_str(),
          resource.details.as_deref().unwrap_or(""),
        ]
        .iter()
        .any(|value| value.to_lowercase().contains(&query));
        if !hit {
          continue;
        }
      }
      items.push(BundleResourceSummary {
        bundle_path: entry.path.clone(),
        bundle_name: entry.name.clone(),
        bundle_changed: entry.changed,
        resource,
      });
    }
  }
  items.sort_by(|left, right| match left.bundle_path.cmp(&right.bundle_path) {
    std::cmp::Ordering::Equal => left.resource.name.cmp(&right.resource.name),
    other => other,
  });
  Ok(items)
}

fn collect_bundle_resource_counts(current: &mut ProjectRuntime) -> Result<BundleResourceCounts, String> {
  let manifest = current
    .dto
    .manifest
    .clone()
    .ok_or_else(|| "当前尚未解包 APK".to_string())?;
  let mut counts = BundleResourceCounts::default();

  for entry in manifest.entries.into_iter().filter(|entry| !entry.is_dir && entry.kind == "bundle") {
    let bundle_manifest = match load_bundle_manifest_into_runtime(current, &entry.path) {
      Ok(value) => value,
      Err(_) => continue,
    };
    for resource in bundle_manifest.resources {
      counts.all += 1;
      let kind = serialized::classify_bundle_resource_kind(&resource.kind);
      match kind.as_ref() {
        "image" => counts.image += 1,
        "text" => counts.text += 1,
        "audio" => counts.audio += 1,
        _ => counts.other += 1,
      }
    }
  }

  Ok(counts)
}

fn append_log(runtime: &mut ProjectRuntime, level: &str, message: String) {
  runtime.activity_logs.push(ActivityLogItem {
    level: level.to_string(),
    message,
    at: shared::now_rfc3339(),
  });
}

fn bundle_work_dir(work_dir: &Path, bundle_path: &str) -> PathBuf {
  let mut hasher = sha1::Sha1::new();
  hasher.update(bundle_path.as_bytes());
  let digest = hasher.finalize();
  let id = digest[..8].iter().map(|byte| format!("{byte:02x}")).collect::<String>();
  work_dir.join(".apkworkshop").join("bundles").join(id)
}

fn file_path_to_string(path: FilePath) -> Option<String> {
  path.into_path().ok().map(|value| value.to_string_lossy().to_string())
}

fn emit_work_progress(
  app: &AppHandle,
  kind: &str,
  current: usize,
  total: usize,
  label: &str,
  path: Option<String>,
  finished: bool,
) -> Result<(), String> {
  let percent = if total == 0 {
    if finished { 100.0 } else { 0.0 }
  } else {
    ((current as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
  };
  app
    .emit(
      "work-progress",
      WorkProgressEvent {
        kind: kind.to_string(),
        current,
        total,
        percent,
        label: label.to_string(),
        path,
        finished,
      },
    )
    .map_err(|err| err.to_string())
}
