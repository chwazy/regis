use tauri::State;

use crate::AppState;
use regis_core::files::templates::{self, TemplatePatch, TemplateSummary};

fn describe(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn list_templates(state: State<'_, AppState>) -> Result<Vec<TemplateSummary>, String> {
    templates::list_summaries(&state.db).map_err(describe)
}

#[tauri::command]
pub async fn update_template(
    state: State<'_, AppState>,
    id: String,
    patch: TemplatePatch,
) -> Result<TemplateSummary, String> {
    templates::update_template(&state.db, &id, &patch).map_err(describe)?;
    templates::get_summary(&state.db, &id).map_err(describe)
}

#[tauri::command]
pub async fn import_template(
    state: State<'_, AppState>,
    path: String,
) -> Result<TemplateSummary, String> {
    let template =
        templates::import_template(&state.db, &state.data_dir, &path).map_err(describe)?;
    state.files.index_now();
    templates::get_summary(&state.db, &template.id).map_err(describe)
}

#[tauri::command]
pub async fn open_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = templates::template_path(&state.db, &state.data_dir, &id).map_err(describe)?;
    templates::open_with_default_app(&path).map_err(describe)
}
