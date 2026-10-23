use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::AppState;
use regis_model::Recording;
use regis_voice::audio::recording::RecordingIndicator;

const TRAY_ID: &str = "recording";
const STOP_MENU_ID: &str = "stop-recording";
const STOP_MENU_LABEL: &str = "Arrêter l'enregistrement";
const MAIN_WINDOW: &str = "main";
const TITLE_PREFIX: &str = "● REC";
const TRAY_ICON: &[u8] = include_bytes!("../../icons/tray/state-recording.png");

pub fn recording_window_title(base: &str) -> String {
    format!("{TITLE_PREFIX} · {base}")
}

pub fn tray_tooltip(title: &str) -> String {
    format!("Enregistrement en cours — {title}")
}

/// Titre de fenêtre « ● REC » et icône de la barre système, créés au démarrage de la session
/// et retirés à sa fin. Les APIs de fenêtre et de tray passent par le thread principal.
pub struct TauriIndicator {
    app: AppHandle,
    original_title: Mutex<Option<String>>,
}

impl TauriIndicator {
    pub fn new(app: AppHandle) -> TauriIndicator {
        TauriIndicator {
            app,
            original_title: Mutex::new(None),
        }
    }

    fn remembered_title(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.original_title
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn build_tray(app: &AppHandle, title: &str) -> tauri::Result<()> {
    let item = MenuItem::with_id(app, STOP_MENU_ID, STOP_MENU_LABEL, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&item])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(TRAY_ICON)?)
        .tooltip(tray_tooltip(title))
        .menu(&menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() != STOP_MENU_ID {
                return;
            }
            let manager = app.state::<AppState>().recording.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(active) = manager.active() {
                    let _ = manager.stop(&active.id).await;
                }
            });
        })
        .build(app)?;
    Ok(())
}

impl RecordingIndicator for TauriIndicator {
    fn show(&self, recording: &Recording) {
        if let Some(window) = self.app.get_webview_window(MAIN_WINDOW) {
            let mut remembered = self.remembered_title();
            if remembered.is_none() {
                *remembered = window.title().ok();
            }
            let base = remembered.clone().unwrap_or_default();
            let _ = window.set_title(&recording_window_title(&base));
        }
        let app = self.app.clone();
        let title = recording.title.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Err(error) = build_tray(&app, &title) {
                eprintln!("[recording] icône de la barre système impossible : {error}");
            }
        });
    }

    fn hide(&self) {
        if let Some(window) = self.app.get_webview_window(MAIN_WINDOW) {
            if let Some(original) = self.remembered_title().take() {
                let _ = window.set_title(&original);
            }
        }
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let _ = app.remove_tray_by_id(TRAY_ID);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_title_starts_with_the_recording_marker() {
        assert!(recording_window_title("Régis").starts_with("● REC"));
        assert!(recording_window_title("Régis").ends_with("Régis"));
    }

    #[test]
    fn the_tooltip_names_the_recording() {
        assert_eq!(
            tray_tooltip("Point client"),
            "Enregistrement en cours — Point client"
        );
    }
}
