pub mod embeddings;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::db::repo::{self, RepoError};
use crate::db::Db;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum LocalModuleId {
    Voice,
    Embeddings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ModelState {
    Missing,
    Downloading,
    Ready,
    Error,
    Unreachable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ModuleState {
    Off,
    Downloading,
    On,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LocalModuleStatus {
    pub id: LocalModuleId,
    pub enabled: bool,
    pub state: ModuleState,
    pub model_state: ModelState,
    pub model_label: String,
    #[ts(type = "number | null")]
    pub size_bytes: Option<u64>,
    #[ts(type = "number | null")]
    pub downloaded_bytes: Option<u64>,
    pub can_delete_model: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModuleDownloadProgress {
    pub id: LocalModuleId,
    #[ts(type = "number")]
    pub downloaded_bytes: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
}

pub const DOWNLOAD_PROGRESS_TOPIC: &str = "module.download.progress";
pub const BACKFILL_PROGRESS_TOPIC: &str = "module.backfill.progress";

pub fn module_state(enabled: bool, model: ModelState) -> ModuleState {
    match (enabled, model) {
        (false, _) => ModuleState::Off,
        (true, ModelState::Downloading) => ModuleState::Downloading,
        (true, ModelState::Ready) => ModuleState::On,
        (true, ModelState::Missing | ModelState::Error | ModelState::Unreachable) => {
            ModuleState::Off
        }
    }
}

pub fn setting_key(id: LocalModuleId) -> &'static str {
    match id {
        LocalModuleId::Voice => "modules.voice.enabled",
        LocalModuleId::Embeddings => "modules.embeddings.enabled",
    }
}

pub fn is_enabled(db: &Db, id: LocalModuleId) -> bool {
    db.with_conn(|conn| repo::get_setting(conn, setting_key(id)))
        .ok()
        .flatten()
        .is_some_and(|value| value == "true")
}

pub fn set_enabled(db: &Db, id: LocalModuleId, enabled: bool) -> Result<(), ModuleError> {
    let value = if enabled { "true" } else { "false" };
    db.with_conn(|conn| repo::set_setting(conn, setting_key(id), value))?;
    Ok(())
}

pub fn require_voice_enabled(db: &Db) -> Result<(), ModuleError> {
    if crate::demo::is_enabled() || is_enabled(db, LocalModuleId::Voice) {
        Ok(())
    } else {
        Err(ModuleError::Disabled("voice"))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ModuleError {
    #[error("module désactivé : {0}")]
    Disabled(&'static str),
    #[error("Ollama injoignable")]
    OllamaUnreachable,
    #[error("téléchargement : {0}")]
    Download(String),
    #[error("modèle corrompu (SHA-256) : {0}")]
    Corrupt(String),
    #[error("suppression impossible : module activé")]
    DeleteWhileEnabled,
    #[error("suppression impossible : le modèle appartient à Ollama")]
    ModelOwnedByOllama,
    #[error(transparent)]
    Repo(#[from] RepoError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::testing::test_db;

    const ALL_MODEL_STATES: [ModelState; 5] = [
        ModelState::Missing,
        ModelState::Downloading,
        ModelState::Ready,
        ModelState::Error,
        ModelState::Unreachable,
    ];

    #[test]
    fn disabled_setting_is_always_off() {
        for model in ALL_MODEL_STATES {
            assert_eq!(module_state(false, model), ModuleState::Off);
        }
    }

    #[test]
    fn enabled_setting_follows_the_model_state() {
        assert_eq!(
            module_state(true, ModelState::Downloading),
            ModuleState::Downloading
        );
        assert_eq!(module_state(true, ModelState::Ready), ModuleState::On);
        for model in [
            ModelState::Missing,
            ModelState::Error,
            ModelState::Unreachable,
        ] {
            assert_eq!(module_state(true, model), ModuleState::Off);
        }
    }

    #[test]
    fn setting_keys_are_stable() {
        assert_eq!(setting_key(LocalModuleId::Voice), "modules.voice.enabled");
        assert_eq!(
            setting_key(LocalModuleId::Embeddings),
            "modules.embeddings.enabled"
        );
    }

    #[test]
    fn absent_setting_means_disabled_and_voice_is_refused() {
        let db = test_db("modules-absent");
        assert!(!is_enabled(&db, LocalModuleId::Embeddings));
        let error = require_voice_enabled(&db).expect_err("voice disabled");
        assert_eq!(error.to_string(), "module désactivé : voice");
        set_enabled(&db, LocalModuleId::Voice, true).expect("enable");
        assert!(require_voice_enabled(&db).is_ok());
        set_enabled(&db, LocalModuleId::Voice, false).expect("disable");
        assert!(require_voice_enabled(&db).is_err());
    }
}
