use tauri::State;

use crate::AppState;
use regis_core::modules::{LocalModuleId, LocalModuleStatus};

fn describe(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn modules_status(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<Vec<LocalModuleStatus>, String> {
    Ok(state
        .modules
        .status_all(&state.db, &state.data_dir, refresh.unwrap_or(false))
        .await)
}

#[tauri::command]
pub async fn module_enable(
    state: State<'_, AppState>,
    id: LocalModuleId,
) -> Result<LocalModuleStatus, String> {
    state
        .modules
        .enable(&state.db, &state.data_dir, &state.bus, &state.files, id)
        .await
        .map_err(describe)
}

#[tauri::command]
pub async fn module_disable(
    state: State<'_, AppState>,
    id: LocalModuleId,
) -> Result<LocalModuleStatus, String> {
    state
        .modules
        .disable(&state.db, &state.data_dir, &state.bus, id)
        .await
        .map_err(describe)
}

#[tauri::command]
pub async fn module_delete_model(
    state: State<'_, AppState>,
    id: LocalModuleId,
) -> Result<LocalModuleStatus, String> {
    state
        .modules
        .delete_model(&state.db, &state.data_dir, id)
        .await
        .map_err(describe)
}
