use std::path::PathBuf;

use tauri::Manager;

pub use regis_core::bootstrap::DataDirOrigin;
use regis_core::bootstrap::{read_bootstrap, resolve_data_dir, DATA_DIR_ENV};

pub fn config_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("regis"))
}

pub fn data_dir_with_origin(app: &tauri::AppHandle) -> (PathBuf, DataDirOrigin) {
    let bootstrap = match read_bootstrap(&config_dir(app)) {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            eprintln!("[paths] bootstrap.json ignoré : {error}");
            None
        }
    };
    let default_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("regis"));
    resolve_data_dir(
        std::env::var_os(DATA_DIR_ENV),
        bootstrap.as_ref(),
        default_dir,
    )
}

#[allow(dead_code)]
pub fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    data_dir_with_origin(app).0
}
