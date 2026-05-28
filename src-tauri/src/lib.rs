mod application {
  pub mod commands;
  pub mod models;
  pub mod state;
}

mod domain {
  pub mod apk;
  pub mod bundle;
  pub mod preview;
}

mod support {
  pub mod shared;
}

use tauri::{LogicalSize, Manager, Monitor, PhysicalPosition, Webview, Window};
use tauri::webview::PageLoadEvent;

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .on_page_load(|webview, payload| {
      if webview.label() != "main" || payload.event() != PageLoadEvent::Finished {
        return;
      }

      let _ = reveal_main_window(&webview);
    })
    .setup(|app| {
      app.manage(application::state::AppState::new(app.handle().clone()));
      adjust_main_window(app)?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      application::commands::bootstrap_project,
      application::commands::scan_project,
      application::commands::choose_apk,
      application::commands::choose_replacement_file,
      application::commands::extract_project,
      application::commands::load_manifest,
      application::commands::tool_status,
      application::commands::replace_apk_entry,
      application::commands::build_apk,
      application::commands::sign_apk,
      application::commands::analyze_bundle,
      application::commands::extract_bundle,
      application::commands::extract_all_bundles,
      application::commands::load_bundle_manifest,
      application::commands::replace_bundle_node,
      application::commands::replace_bundle_resource,
      application::commands::build_bundle,
      application::commands::preview_apk_entry,
      application::commands::preview_bundle_node,
      application::commands::preview_bundle_resource,
      application::commands::list_bundle_resources,
      application::commands::bundle_resource_counts,
      application::commands::open_path,
      application::commands::activity_logs
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn adjust_main_window(app: &mut tauri::App) -> Result<(), tauri::Error> {
  let Some(window) = app.get_webview_window("main") else {
    return Ok(());
  };

  let monitor = window
    .current_monitor()?
    .or_else(|| window.primary_monitor().ok().flatten());

  let Some(monitor) = monitor else {
    let _ = window.center();
    let _ = window.show();
    return Ok(());
  };

  let scale = monitor.scale_factor().max(1.0);
  let work_area = monitor.work_area();
  let work_width = (work_area.size.width as f64 / scale).floor().max(1.0);
  let work_height = (work_area.size.height as f64 / scale).floor().max(1.0);

  let horizontal_margin = 120.0;
  let vertical_margin = 96.0;
  let min_supported_width = 1100.0;
  let min_supported_height = 760.0;

  let max_target_width = (work_width - horizontal_margin).max(min_supported_width);
  let max_target_height = (work_height - vertical_margin).max(min_supported_height);

  let target_width = 1600.0_f64.min(max_target_width);
  let target_height = 960.0_f64.min(max_target_height);

  let min_width = 1480.0_f64.min(target_width);
  let min_height = 900.0_f64.min(target_height);

  window.set_min_size(Some(LogicalSize::new(min_width, min_height)))?;
  window.set_size(LogicalSize::new(target_width, target_height))?;
  center_webview_window_on_monitor(&window, &monitor)?;
  Ok(())
}

fn center_webview_window_on_monitor(
  window: &tauri::WebviewWindow,
  monitor: &Monitor,
) -> Result<(), tauri::Error> {
  let outer_size = window.outer_size()?;
  let monitor_size = monitor.size();
  let monitor_position = monitor.position();

  let target_x = monitor_position.x + ((monitor_size.width as i32 - outer_size.width as i32) / 2);
  let target_y = monitor_position.y + ((monitor_size.height as i32 - outer_size.height as i32) / 2);

  window.set_position(PhysicalPosition::new(target_x.max(monitor_position.x), target_y.max(monitor_position.y)))?;
  Ok(())
}

fn center_window_on_monitor(window: &Window, monitor: &Monitor) -> Result<(), tauri::Error> {
  let outer_size = window.outer_size()?;
  let monitor_size = monitor.size();
  let monitor_position = monitor.position();

  let target_x = monitor_position.x + ((monitor_size.width as i32 - outer_size.width as i32) / 2);
  let target_y = monitor_position.y + ((monitor_size.height as i32 - outer_size.height as i32) / 2);

  window.set_position(PhysicalPosition::new(target_x.max(monitor_position.x), target_y.max(monitor_position.y)))?;
  Ok(())
}

fn reveal_main_window(webview: &Webview) -> Result<(), tauri::Error> {
  let window = webview.window();
  if let Some(monitor) = window.current_monitor()?.or_else(|| window.primary_monitor().ok().flatten()) {
    center_window_on_monitor(&window, &monitor)?;
  } else {
    let _ = window.center();
  }

  window.show()?;

  if let Some(monitor) = window.current_monitor()?.or_else(|| window.primary_monitor().ok().flatten()) {
    let _ = center_window_on_monitor(&window, &monitor);
  } else {
    let _ = window.center();
  }

  let _ = window.set_focus();
  Ok(())
}
