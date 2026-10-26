pub mod audio;
pub mod brain;
pub mod dashboard;
pub mod data;
pub mod files;
pub mod meetings;
pub mod modules;
pub mod pty;
pub mod recording;
pub mod settings;
pub mod templates;
pub mod updater;

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::AppState;
use regis_core::sidecar::CALL_TIMEOUT;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub schema_version: i64,
    pub vec_version: String,
    pub sidecar: Option<Value>,
}

#[tauri::command]
pub async fn app_info(state: tauri::State<'_, AppState>) -> Result<AppInfo, String> {
    let schema_version = state
        .db
        .schema_version()
        .map_err(|error| error.to_string())?;
    let vec_version = state.db.vec_version().map_err(|error| error.to_string())?;
    let sidecar = state
        .sidecar
        .call::<Value>("system.ping", json!({}))
        .await
        .ok();
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        data_dir: state.data_dir.display().to_string(),
        schema_version,
        vec_version,
        sidecar,
    })
}

#[tauri::command]
pub async fn sidecar_call(
    state: tauri::State<'_, AppState>,
    method: String,
    params: Value,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    let timeout = timeout_secs.map(Duration::from_secs);
    state
        .sidecar
        .call_with_timeout::<Value>(&method, params, timeout.unwrap_or(CALL_TIMEOUT))
        .await
        .map_err(|error| error.to_string())
}
