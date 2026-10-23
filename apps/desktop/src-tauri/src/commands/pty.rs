use crate::AppState;

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state
        .pty
        .write(&id, data.as_bytes())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .pty
        .resize(&id, cols, rows)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pty_close(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.pty.close(&id).map_err(|error| error.to_string())
}
