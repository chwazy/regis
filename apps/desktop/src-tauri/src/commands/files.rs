use tauri::State;

use crate::AppState;
use regis_core::db::repo;
use regis_core::files::sources::{self, FileSourceInfo};
use regis_core::modules::embeddings::active_embedder;
use regis_core::search;
use regis_model::SearchHit;
use regis_model::{Entity, FileEntry, Link};

const DEFAULT_SEARCH_LIMIT: usize = 10;

fn describe(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn list_file_sources(state: State<'_, AppState>) -> Result<Vec<FileSourceInfo>, String> {
    sources::list_sources(&state.db).map_err(describe)
}

#[tauri::command]
pub async fn add_file_source(
    state: State<'_, AppState>,
    kind: String,
    path: String,
    watch_mode: Option<String>,
    poll_minutes: Option<i64>,
) -> Result<FileSourceInfo, String> {
    let source = sources::add_source(&state.db, &kind, &path, watch_mode.as_deref(), poll_minutes)
        .map_err(describe)?;
    state.files.reload();
    state
        .db
        .with_conn(|conn| sources::source_info(conn, &source.id))
        .map_err(describe)
}

#[tauri::command]
pub async fn remove_file_source(state: State<'_, AppState>, id: String) -> Result<(), String> {
    sources::remove_source(&state.db, &id).map_err(describe)?;
    state.files.reload();
    Ok(())
}

#[tauri::command]
pub async fn rescan_source(state: State<'_, AppState>, id: String) -> Result<(), String> {
    sources::get_source(&state.db, &id).map_err(describe)?;
    state.files.rescan(&id);
    Ok(())
}

#[tauri::command]
pub async fn import_files(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<FileEntry>, String> {
    let imported = sources::import_files(&state.db, &state.data_dir, &paths).map_err(describe)?;
    announce_imports(&state, &imported);
    Ok(imported)
}

#[tauri::command]
pub async fn import_clipboard_image(
    state: State<'_, AppState>,
    png_base64: String,
) -> Result<FileEntry, String> {
    let entry = sources::import_clipboard_image(&state.db, &state.data_dir, &png_base64)
        .map_err(describe)?;
    announce_imports(&state, std::slice::from_ref(&entry));
    Ok(entry)
}

fn announce_imports(state: &AppState, imported: &[FileEntry]) {
    let Some(first) = imported.first() else {
        return;
    };
    if let Ok(info) = state
        .db
        .with_conn(|conn| sources::source_info(conn, &first.source_id))
    {
        state.bus.emit("index.progress", &info);
    }
    state.files.index_now();
}

#[tauri::command]
pub async fn list_files(
    state: State<'_, AppState>,
    role: Option<String>,
    status: Option<String>,
    unlinked_only: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    sources::list_files(
        &state.db,
        role.as_deref(),
        status.as_deref(),
        unlinked_only.unwrap_or(false),
    )
    .map_err(describe)
}

#[tauri::command]
pub async fn link_file(
    state: State<'_, AppState>,
    file_id: String,
    entity_id: String,
    rel: String,
) -> Result<Link, String> {
    let link = sources::link_file(&state.db, &file_id, &entity_id, &rel).map_err(describe)?;
    let source_id = state
        .db
        .with_conn(|conn| repo::require::<FileEntry>(conn, &file_id))
        .map(|entry| entry.source_id)
        .map_err(describe)?;
    if let Ok(info) = state
        .db
        .with_conn(|conn| sources::source_info(conn, &source_id))
    {
        state.bus.emit("index.progress", &info);
    }
    Ok(link)
}

#[tauri::command]
pub async fn list_linkable_entities(state: State<'_, AppState>) -> Result<Vec<Entity>, String> {
    state
        .db
        .with_conn(|conn| repo::list_where(conn, "1 = 1", "name COLLATE NOCASE", Vec::new()))
        .map_err(describe)
}

#[tauri::command]
pub async fn search(
    state: State<'_, AppState>,
    query: String,
    k: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let embedder = active_embedder(&state.db).await;
    search::search_chunks(
        &state.db,
        embedder.as_ref(),
        &query,
        k.unwrap_or(DEFAULT_SEARCH_LIMIT),
    )
    .await
    .map_err(describe)
}
