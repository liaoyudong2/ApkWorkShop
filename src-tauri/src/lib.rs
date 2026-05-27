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

use tauri::Manager;

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      app.manage(application::state::AppState::new(app.handle().clone()));
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
      application::commands::open_path,
      application::commands::activity_logs
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
