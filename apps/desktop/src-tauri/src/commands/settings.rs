use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, State};
use ts_rs::TS;

use crate::paths::DataDirOrigin;
use crate::AppState;
use regis_core::bootstrap::{self, Bootstrap, BootstrapError};
use regis_core::demo;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub data_dir_origin: DataDirOrigin,
    pub demo: bool,
    pub config_dir: String,
    pub force_onboarding: bool,
    pub resume_url: Option<String>,
}

const FORCE_ONBOARDING_ENV: &str = "REGIS_FORCE_ONBOARDING";

#[tauri::command]
pub async fn get_app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        data_dir: state.data_dir.display().to_string(),
        data_dir_origin: state.data_dir_origin,
        demo: demo::is_enabled(),
        config_dir: state.config_dir.display().to_string(),
        force_onboarding: std::env::var(FORCE_ONBOARDING_ENV).ok().as_deref() == Some("1"),
        resume_url: bootstrap::take_resume_url(&state.config_dir)
            .map_err(|error| error.to_string())?,
    })
}

/// Valide le dossier, écrit `bootstrap.json`, puis demande le redémarrage.
pub fn apply_data_dir(
    config_dir: &std::path::Path,
    origin: DataDirOrigin,
    path: &str,
    resume_url: Option<&str>,
) -> Result<(), BootstrapError> {
    if origin == DataDirOrigin::Env {
        return Err(BootstrapError::DataDirLockedByEnv);
    }
    let target = PathBuf::from(path.trim());
    bootstrap::validate_data_dir(&target)?;
    let mut next = Bootstrap::with_data_dir(target);
    if let Some(url) = resume_url {
        if !bootstrap::is_valid_resume_url(url) {
            return Err(BootstrapError::Invalid(format!(
                "URL de reprise refusée : {url}"
            )));
        }
        next.resume_url = Some(url.to_owned());
    }
    bootstrap::write_bootstrap(config_dir, &next)
}

#[tauri::command]
pub async fn set_data_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    resume_url: Option<String>,
) -> Result<(), String> {
    apply_data_dir(
        &state.config_dir,
        state.data_dir_origin,
        &path,
        resume_url.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_origin_locks_the_data_dir_and_writes_nothing() {
        let config = std::env::temp_dir().join(format!("regis-settings-{}", std::process::id()));
        let error = apply_data_dir(&config, DataDirOrigin::Env, "/x", None).unwrap_err();
        assert!(error.to_string().contains("REGIS_DATA_DIR"));
        assert!(!config.join(bootstrap::BOOTSTRAP_FILE).exists());
    }

    #[test]
    fn valid_dir_is_written_to_bootstrap() {
        let root =
            std::env::temp_dir().join(format!("regis-settings-ok-{}", ulid::Ulid::generate()));
        let config = root.join("config");
        let target = root.join("data");
        std::fs::create_dir_all(&target).unwrap();
        apply_data_dir(
            &config,
            DataDirOrigin::Default,
            target.to_str().expect("utf-8 temp path"),
            Some("/bienvenue?profile=pro&step=data"),
        )
        .unwrap();
        let written = bootstrap::read_bootstrap(&config).unwrap().unwrap();
        assert_eq!(written.data_dir, Some(target));
        assert_eq!(
            written.resume_url.as_deref(),
            Some("/bienvenue?profile=pro&step=data")
        );
    }
}
