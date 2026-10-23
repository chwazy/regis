use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::models::{self, SttModelSpec};
use super::{FakeSttEngine, SttEngine, SttError};
use regis_core::events::EventBus;
use regis_core::modules::{LocalModuleId, ModuleDownloadProgress, DOWNLOAD_PROGRESS_TOPIC};
use regis_stt_whisper::WhisperEngine;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum SttModelState {
    Missing,
    Downloading,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    pub model_id: String,
    pub state: SttModelState,
    #[ts(type = "number | null")]
    pub downloaded_bytes: Option<u64>,
    #[ts(type = "number | null")]
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub capture_supported: bool,
    pub loopback_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SttDownloadProgress {
    pub model_id: String,
    #[ts(type = "number")]
    pub downloaded_bytes: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
}

struct VerifiedFile {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

#[derive(Default)]
struct Inner {
    download: Option<SttDownloadProgress>,
    last_error: Option<(String, String)>,
    verified: Option<VerifiedFile>,
}

#[derive(Default)]
pub struct SttState {
    inner: Mutex<Inner>,
    engine: tokio::sync::Mutex<Option<(String, Arc<dyn SttEngine>)>>,
}

impl SttState {
    pub fn new() -> SttState {
        SttState::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Calcule l'état ; la vérification SHA-256 (une fois, puis cache taille + date) peut durer.
    pub fn status(&self, data_dir: &Path, model_id: &str, demo: bool) -> SttStatus {
        let mut status = SttStatus {
            model_id: model_id.to_owned(),
            state: SttModelState::Missing,
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
            capture_supported: crate::audio::is_capture_supported(),
            loopback_supported: crate::audio::is_loopback_supported(),
        };
        if demo {
            status.state = SttModelState::Ready;
            return status;
        }
        let Some(spec) = models::find_model(model_id) else {
            status.state = SttModelState::Error;
            status.error = Some(format!("modèle inconnu : {model_id}"));
            return status;
        };
        status.total_bytes = Some(spec.size_bytes);
        {
            let inner = self.lock();
            if let Some(progress) = inner.download.as_ref().filter(|p| p.model_id == model_id) {
                status.state = SttModelState::Downloading;
                status.downloaded_bytes = Some(progress.downloaded_bytes);
                status.total_bytes = Some(progress.total_bytes);
                return status;
            }
        }
        match self.check_file(data_dir, spec) {
            FileCheck::Absent => {
                let inner = self.lock();
                if let Some((_, message)) =
                    inner.last_error.as_ref().filter(|(id, _)| id == model_id)
                {
                    status.state = SttModelState::Error;
                    status.error = Some(message.clone());
                }
            }
            FileCheck::Valid => status.state = SttModelState::Ready,
            FileCheck::Invalid(message) => {
                status.state = SttModelState::Error;
                status.error = Some(message);
            }
        }
        status
    }

    fn check_file(&self, data_dir: &Path, spec: &SttModelSpec) -> FileCheck {
        let path = models::model_path(data_dir, spec);
        let Ok(metadata) = std::fs::metadata(&path) else {
            return FileCheck::Absent;
        };
        let (len, modified) = (metadata.len(), metadata.modified().ok());
        if self
            .lock()
            .verified
            .as_ref()
            .is_some_and(|v| v.path == path && v.len == len && v.modified == modified)
        {
            return FileCheck::Valid;
        }
        match models::verify_sha256(&path, spec.sha256) {
            Ok(true) => {
                self.lock().verified = Some(VerifiedFile {
                    path,
                    len,
                    modified,
                });
                FileCheck::Valid
            }
            Ok(false) => FileCheck::Invalid(SttError::ModelCorrupt(spec.id.to_owned()).to_string()),
            Err(error) => FileCheck::Invalid(error.to_string()),
        }
    }

    /// Téléchargement explicite d'un modèle ; un seul à la fois.
    pub async fn download(
        self: &Arc<Self>,
        spec: &'static SttModelSpec,
        data_dir: &Path,
        bus: &EventBus,
    ) -> Result<(), SttError> {
        {
            let mut inner = self.lock();
            if inner.download.is_some() {
                return Err(SttError::Download(
                    "un téléchargement est déjà en cours".to_owned(),
                ));
            }
            inner.last_error = None;
            inner.download = Some(SttDownloadProgress {
                model_id: spec.id.to_owned(),
                downloaded_bytes: 0,
                total_bytes: spec.size_bytes,
            });
        }
        let reporter = self.clone();
        let bus = bus.clone();
        let result = models::download_model(spec, data_dir, move |downloaded, total| {
            let progress = SttDownloadProgress {
                model_id: spec.id.to_owned(),
                downloaded_bytes: downloaded,
                total_bytes: total,
            };
            reporter.lock().download = Some(progress.clone());
            bus.emit(
                DOWNLOAD_PROGRESS_TOPIC,
                &ModuleDownloadProgress {
                    id: LocalModuleId::Voice,
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                },
            );
        })
        .await;
        let mut inner = self.lock();
        inner.download = None;
        if let Err(error) = &result {
            inner.last_error = Some((spec.id.to_owned(), error.to_string()));
        }
        result.map(|_| ())
    }

    /// Un seul moteur chargé, partagé, créé à la première utilisation.
    pub async fn engine(
        &self,
        data_dir: &Path,
        model_id: &str,
        demo: bool,
    ) -> Result<Arc<dyn SttEngine>, SttError> {
        let mut slot = self.engine.lock().await;
        if demo {
            let engine: Arc<dyn SttEngine> = Arc::new(FakeSttEngine::demo());
            *slot = Some((model_id.to_owned(), engine.clone()));
            return Ok(engine);
        }
        if let Some((loaded_id, engine)) = slot.as_ref() {
            if loaded_id == model_id {
                return Ok(engine.clone());
            }
        }
        let spec = models::find_model(model_id)
            .ok_or_else(|| SttError::ModelMissing(format!("modèle inconnu : {model_id}")))?;
        let path = models::model_path(data_dir, spec);
        let engine = tokio::task::spawn_blocking(move || WhisperEngine::load(&path))
            .await
            .map_err(|error| SttError::Load(error.to_string()))??;
        let engine: Arc<dyn SttEngine> = Arc::new(engine);
        *slot = Some((model_id.to_owned(), engine.clone()));
        Ok(engine)
    }
}

enum FileCheck {
    Absent,
    Valid,
    Invalid(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("regis-stt-state-{name}-{}", ulid::Ulid::generate()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_gives_missing_state() {
        let status = SttState::new().status(&temp_dir("missing"), "small-q8_0", false);
        assert_eq!(status.state, SttModelState::Missing);
        assert_eq!(status.total_bytes, Some(264_464_607));
    }

    #[test]
    fn wrong_content_gives_error_state() {
        let dir = temp_dir("corrupt");
        let spec = models::find_model("small-q8_0").unwrap();
        let path = models::model_path(&dir, spec);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"pas un modele").unwrap();
        let status = SttState::new().status(&dir, "small-q8_0", false);
        assert_eq!(status.state, SttModelState::Error);
    }

    #[test]
    fn demo_mode_is_ready_without_any_file() {
        let status = SttState::new().status(&temp_dir("demo"), "large-v3-turbo-q5_0", true);
        assert_eq!(status.state, SttModelState::Ready);
    }

    #[test]
    fn unknown_model_is_an_error() {
        let status = SttState::new().status(&temp_dir("unknown"), "inconnu", false);
        assert_eq!(status.state, SttModelState::Error);
    }
}
