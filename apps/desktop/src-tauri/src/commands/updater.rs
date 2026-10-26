use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use ts_rs::TS;

use crate::AppState;

const PROGRESS_TOPIC: &str = "update.download.progress";

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    #[ts(type = "number")]
    pub downloaded: u64,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let info = update.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    });
    *lock(&state.pending_update) = update;
    Ok(info)
}

#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Installation des mises à jour désactivée en mode développement".into());
    }
    let update = lock(&state.pending_update)
        .take()
        .ok_or("Aucune mise à jour en attente : relancer la vérification")?;
    let bus = state.bus.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                bus.emit(PROGRESS_TOPIC, &UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    app.restart();
}

fn lock(pending: &PendingUpdate) -> std::sync::MutexGuard<'_, Option<Update>> {
    pending
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
