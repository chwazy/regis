use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::audio::devices::normalize_device_setting;
use crate::stt::models::{self, DEFAULT_STT_MODEL};
use crate::stt::state::SttModelState;
use crate::stt::SttState;
use crate::stt::SETTING_STT_MODEL;
use regis_core::db::repo;
use regis_core::db::Db;
use regis_core::events::EventBus;
use regis_core::files::indexer::load_embedder;
use regis_core::files::watcher::WatcherHandle;
use regis_core::modules::embeddings::{self, BGE_M3_MODEL};
use regis_core::modules::{
    is_enabled, module_state, set_enabled, LocalModuleId, LocalModuleStatus, ModelState,
    ModuleDownloadProgress, ModuleError, ModuleState, DOWNLOAD_PROGRESS_TOPIC,
};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Default)]
struct Inner {
    embeddings_pull: Option<EmbeddingsPull>,
    embeddings_error: Option<String>,
    voice_starting: bool,
}

#[derive(Clone, Copy, Default)]
struct EmbeddingsPull {
    downloaded: u64,
    total: Option<u64>,
}

pub struct ModuleManager {
    inner: Mutex<Inner>,
    stt: Arc<SttState>,
}

impl ModuleManager {
    pub fn new(stt: Arc<SttState>) -> ModuleManager {
        ModuleManager {
            inner: Mutex::new(Inner::default()),
            stt,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub async fn status_all(
        &self,
        db: &Arc<Db>,
        data_dir: &Path,
        force_refresh: bool,
    ) -> Vec<LocalModuleStatus> {
        vec![
            self.status(db, data_dir, LocalModuleId::Voice, force_refresh)
                .await,
            self.status(db, data_dir, LocalModuleId::Embeddings, force_refresh)
                .await,
        ]
    }

    pub async fn status(
        &self,
        db: &Arc<Db>,
        data_dir: &Path,
        id: LocalModuleId,
        force_refresh: bool,
    ) -> LocalModuleStatus {
        match id {
            LocalModuleId::Voice => self.voice_status(db, data_dir).await,
            LocalModuleId::Embeddings => self.embeddings_status(db, force_refresh).await,
        }
    }

    async fn voice_status(&self, db: &Arc<Db>, data_dir: &Path) -> LocalModuleStatus {
        let model_id = selected_stt_model(db);
        let stt = self.stt.clone();
        let data_dir = data_dir.to_owned();
        let checked_id = model_id.clone();
        let status = tokio::task::spawn_blocking(move || {
            stt.status(&data_dir, &checked_id, regis_core::demo::is_enabled())
        })
        .await;
        let enabled = is_enabled(db, LocalModuleId::Voice);
        let Ok(status) = status else {
            return LocalModuleStatus {
                id: LocalModuleId::Voice,
                enabled,
                state: module_state(enabled, ModelState::Error),
                model_state: ModelState::Error,
                model_label: model_id,
                size_bytes: None,
                downloaded_bytes: None,
                can_delete_model: true,
                error: Some("vérification du modèle impossible".to_owned()),
            };
        };
        let starting = self.lock().voice_starting;
        let model_state = match status.state {
            SttModelState::Missing if starting => ModelState::Downloading,
            SttModelState::Missing => ModelState::Missing,
            SttModelState::Downloading => ModelState::Downloading,
            SttModelState::Ready => ModelState::Ready,
            SttModelState::Error => ModelState::Error,
        };
        LocalModuleStatus {
            id: LocalModuleId::Voice,
            enabled,
            state: displayed_state(enabled, model_state),
            model_state,
            model_label: model_id,
            size_bytes: status.total_bytes,
            downloaded_bytes: status.downloaded_bytes,
            can_delete_model: true,
            error: status.error,
        }
    }

    async fn embeddings_status(&self, db: &Arc<Db>, force_refresh: bool) -> LocalModuleStatus {
        let enabled = is_enabled(db, LocalModuleId::Embeddings);
        let pull = self.lock().embeddings_pull;
        let error = self.lock().embeddings_error.clone();
        let (model_state, size_bytes, downloaded_bytes) = if regis_core::demo::is_enabled() {
            (ModelState::Ready, None, None)
        } else if let Some(pull) = pull {
            (ModelState::Downloading, pull.total, Some(pull.downloaded))
        } else if !enabled && !force_refresh {
            (ModelState::Missing, None, None)
        } else {
            let url = load_embedder(db).url;
            let state = embeddings::model_state(&url, force_refresh).await;
            let state = if state == ModelState::Missing && error.is_some() {
                ModelState::Error
            } else {
                state
            };
            (state, None, None)
        };
        LocalModuleStatus {
            id: LocalModuleId::Embeddings,
            enabled,
            state: displayed_state(enabled, model_state),
            model_state,
            model_label: BGE_M3_MODEL.to_owned(),
            size_bytes,
            downloaded_bytes,
            can_delete_model: false,
            error: if model_state == ModelState::Ready {
                None
            } else {
                error
            },
        }
    }

    pub async fn enable(
        self: &Arc<Self>,
        db: &Arc<Db>,
        data_dir: &Path,
        bus: &EventBus,
        files: &WatcherHandle,
        id: LocalModuleId,
    ) -> Result<LocalModuleStatus, ModuleError> {
        let current = self.status(db, data_dir, id, true).await;
        match current.model_state {
            ModelState::Ready => {
                write_enabled(db, bus, id, true)?;
                files.index_now();
            }
            ModelState::Downloading => {}
            ModelState::Unreachable => return Err(ModuleError::OllamaUnreachable),
            ModelState::Missing | ModelState::Error => {
                self.start_download(db, data_dir, bus, files, id);
            }
        }
        Ok(self.status(db, data_dir, id, false).await)
    }

    fn start_download(
        self: &Arc<Self>,
        db: &Arc<Db>,
        data_dir: &Path,
        bus: &EventBus,
        files: &WatcherHandle,
        id: LocalModuleId,
    ) {
        {
            let mut inner = self.lock();
            match id {
                LocalModuleId::Voice => inner.voice_starting = true,
                LocalModuleId::Embeddings => {
                    inner.embeddings_error = None;
                    inner.embeddings_pull = Some(EmbeddingsPull::default());
                }
            }
        }
        let manager = self.clone();
        let (db, data_dir, bus, files) =
            (db.clone(), data_dir.to_owned(), bus.clone(), files.clone());
        tokio::spawn(async move {
            let result = match id {
                LocalModuleId::Voice => manager.download_voice(&db, &data_dir, &bus).await,
                LocalModuleId::Embeddings => manager.pull_embeddings(&db, &bus).await,
            };
            let outcome = result.and_then(|()| write_enabled(&db, &bus, id, true));
            match outcome {
                Ok(()) => files.index_now(),
                Err(error) => {
                    eprintln!("[modules] activation de {id:?} impossible : {error}");
                    if id == LocalModuleId::Embeddings {
                        manager.lock().embeddings_error = Some(error.to_string());
                    }
                    bus.emit(
                        "settings.changed",
                        &json!({ "key": regis_core::modules::setting_key(id) }),
                    );
                }
            }
            match id {
                LocalModuleId::Voice => manager.lock().voice_starting = false,
                LocalModuleId::Embeddings => {
                    manager.lock().embeddings_pull = None;
                    embeddings::invalidate_state_cache();
                }
            }
        });
    }

    async fn download_voice(
        &self,
        db: &Arc<Db>,
        data_dir: &Path,
        bus: &EventBus,
    ) -> Result<(), ModuleError> {
        let model_id = selected_stt_model(db);
        let spec = models::find_model(&model_id)
            .ok_or_else(|| ModuleError::Download(format!("modèle inconnu : {model_id}")))?;
        self.stt
            .download(spec, data_dir, bus)
            .await
            .map_err(|error| match error {
                crate::stt::SttError::ModelCorrupt(name) => ModuleError::Corrupt(name),
                other => ModuleError::Download(other.to_string()),
            })
    }

    pub async fn pull_embeddings(&self, db: &Arc<Db>, bus: &EventBus) -> Result<(), ModuleError> {
        let url = load_embedder(db).url;
        let mut last_report = Instant::now() - PROGRESS_INTERVAL;
        let mut largest_total = 0_u64;
        embeddings::pull_bge_m3(&url, |progress| {
            let Some(total) = progress.total.filter(|total| *total >= largest_total) else {
                return;
            };
            largest_total = total;
            let downloaded = progress.completed.unwrap_or(0);
            self.lock().embeddings_pull = Some(EmbeddingsPull {
                downloaded,
                total: Some(total),
            });
            if last_report.elapsed() >= PROGRESS_INTERVAL {
                last_report = Instant::now();
                bus.emit(
                    DOWNLOAD_PROGRESS_TOPIC,
                    &ModuleDownloadProgress {
                        id: LocalModuleId::Embeddings,
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                    },
                );
            }
        })
        .await
    }

    pub async fn disable(
        &self,
        db: &Arc<Db>,
        data_dir: &Path,
        bus: &EventBus,
        id: LocalModuleId,
    ) -> Result<LocalModuleStatus, ModuleError> {
        write_enabled(db, bus, id, false)?;
        Ok(self.status(db, data_dir, id, false).await)
    }

    pub async fn delete_model(
        &self,
        db: &Arc<Db>,
        data_dir: &Path,
        id: LocalModuleId,
    ) -> Result<LocalModuleStatus, ModuleError> {
        if id != LocalModuleId::Voice {
            return Err(ModuleError::ModelOwnedByOllama);
        }
        if is_enabled(db, id) {
            return Err(ModuleError::DeleteWhileEnabled);
        }
        if let Some(spec) = models::find_model(&selected_stt_model(db)) {
            let path: PathBuf = models::model_path(data_dir, spec);
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(ModuleError::Download(error.to_string())),
            }
        }
        Ok(self.status(db, data_dir, id, false).await)
    }
}

fn displayed_state(enabled: bool, model: ModelState) -> ModuleState {
    if model == ModelState::Downloading {
        ModuleState::Downloading
    } else {
        module_state(enabled, model)
    }
}

fn write_enabled(
    db: &Db,
    bus: &EventBus,
    id: LocalModuleId,
    enabled: bool,
) -> Result<(), ModuleError> {
    set_enabled(db, id, enabled)?;
    bus.emit(
        "settings.changed",
        &json!({ "key": regis_core::modules::setting_key(id) }),
    );
    Ok(())
}

pub fn selected_stt_model(db: &Db) -> String {
    let stored = db
        .with_conn(|conn| repo::get_setting(conn, SETTING_STT_MODEL))
        .ok()
        .flatten();
    normalize_device_setting(stored).unwrap_or_else(|| DEFAULT_STT_MODEL.to_owned())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use regis_core::db::repo::testing::test_db;
    use regis_core::events::{EventSink, RegisEvent};
    use regis_core::modules::embeddings::testing::{start, unreachable_url};

    struct TopicSink(Mutex<Vec<String>>);

    impl EventSink for TopicSink {
        fn publish(&self, event: RegisEvent) {
            if let Ok(mut topics) = self.0.lock() {
                topics.push(event.topic);
            }
        }
    }

    struct Fixture {
        db: Arc<Db>,
        data_dir: PathBuf,
        sink: Arc<TopicSink>,
        bus: EventBus,
        manager: Arc<ModuleManager>,
        files: WatcherHandle,
    }

    fn fixture(name: &str, ollama_url: &str) -> Fixture {
        let db = Arc::new(test_db(&format!("modules-{name}")));
        db.with_conn(|conn| repo::set_setting(conn, "ollama.url", ollama_url))
            .expect("url");
        let sink = Arc::new(TopicSink(Mutex::new(Vec::new())));
        let bus = EventBus::new(sink.clone());
        let files = regis_core::files::watcher::spawn(db.clone(), bus.clone());
        Fixture {
            db,
            data_dir: std::env::temp_dir()
                .join(format!("regis-modules-{}-{name}", std::process::id())),
            sink,
            bus,
            manager: Arc::new(ModuleManager::new(Arc::new(SttState::new()))),
            files,
        }
    }

    async fn settle(fixture: &Fixture) -> LocalModuleStatus {
        for _ in 0..100 {
            let status = fixture
                .manager
                .status(
                    &fixture.db,
                    &fixture.data_dir,
                    LocalModuleId::Embeddings,
                    true,
                )
                .await;
            if status.model_state != ModelState::Downloading {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("pull did not finish");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn enabling_embeddings_without_the_model_pulls_it_then_enables() {
        let body =
            "{\"status\":\"pulling abc\",\"completed\":5,\"total\":10}\n{\"status\":\"success\"}\n";
        let ollama = start(&[], body);
        let fixture = fixture("pull", &ollama.url);

        let status = fixture
            .manager
            .enable(
                &fixture.db,
                &fixture.data_dir,
                &fixture.bus,
                &fixture.files,
                LocalModuleId::Embeddings,
            )
            .await
            .expect("enable");
        assert!(!status.enabled);
        settle(&fixture).await;

        assert!(is_enabled(&fixture.db, LocalModuleId::Embeddings));
        assert_eq!(ollama.pulls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let topics = fixture.sink.0.lock().expect("topics").clone();
        assert!(topics.iter().any(|topic| topic == DOWNLOAD_PROGRESS_TOPIC));
        assert!(topics.iter().any(|topic| topic == "settings.changed"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_pull_leaves_the_module_disabled_with_the_error() {
        let ollama = start(&[], "{\"error\":\"boom\"}\n");
        let fixture = fixture("pull-error", &ollama.url);

        fixture
            .manager
            .enable(
                &fixture.db,
                &fixture.data_dir,
                &fixture.bus,
                &fixture.files,
                LocalModuleId::Embeddings,
            )
            .await
            .expect("enable");
        let status = settle(&fixture).await;

        assert!(!is_enabled(&fixture.db, LocalModuleId::Embeddings));
        assert!(status.error.expect("error").contains("boom"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn enabling_with_an_unreachable_ollama_writes_nothing() {
        let fixture = fixture("unreachable", &unreachable_url());
        let error = fixture
            .manager
            .enable(
                &fixture.db,
                &fixture.data_dir,
                &fixture.bus,
                &fixture.files,
                LocalModuleId::Embeddings,
            )
            .await
            .expect_err("unreachable");
        assert!(matches!(error, ModuleError::OllamaUnreachable));
        assert!(!is_enabled(&fixture.db, LocalModuleId::Embeddings));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn enabling_with_the_model_present_is_immediate_and_disabling_keeps_it() {
        let ollama = start(&["bge-m3:latest"], "");
        let fixture = fixture("present", &ollama.url);

        let status = fixture
            .manager
            .enable(
                &fixture.db,
                &fixture.data_dir,
                &fixture.bus,
                &fixture.files,
                LocalModuleId::Embeddings,
            )
            .await
            .expect("enable");
        assert!(status.enabled);
        assert_eq!(status.state, ModuleState::On);
        assert_eq!(ollama.pulls.load(std::sync::atomic::Ordering::SeqCst), 0);

        let status = fixture
            .manager
            .disable(
                &fixture.db,
                &fixture.data_dir,
                &fixture.bus,
                LocalModuleId::Embeddings,
            )
            .await
            .expect("disable");
        assert_eq!(status.state, ModuleState::Off);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_disabled_embeddings_module_never_queries_ollama_unless_asked() {
        let ollama = start(&["bge-m3:latest"], "");
        let fixture = fixture("disabled-status", &ollama.url);

        let statuses = fixture
            .manager
            .status_all(&fixture.db, &fixture.data_dir, false)
            .await;
        let embeddings = &statuses[1];
        assert_eq!(embeddings.state, ModuleState::Off);
        assert!(!embeddings.enabled);
        assert_eq!(
            ollama
                .tags_requests
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );

        let checked = fixture
            .manager
            .status(
                &fixture.db,
                &fixture.data_dir,
                LocalModuleId::Embeddings,
                true,
            )
            .await;
        assert_eq!(checked.model_state, ModelState::Ready);
        assert_eq!(
            ollama
                .tags_requests
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn embeddings_model_cannot_be_deleted_and_voice_model_only_when_disabled() {
        let fixture = fixture("delete", &unreachable_url());
        let refused = fixture
            .manager
            .delete_model(&fixture.db, &fixture.data_dir, LocalModuleId::Embeddings)
            .await;
        assert!(matches!(refused, Err(ModuleError::ModelOwnedByOllama)));

        set_enabled(&fixture.db, LocalModuleId::Voice, true).expect("enable");
        let refused = fixture
            .manager
            .delete_model(&fixture.db, &fixture.data_dir, LocalModuleId::Voice)
            .await;
        assert!(matches!(refused, Err(ModuleError::DeleteWhileEnabled)));
    }
}
