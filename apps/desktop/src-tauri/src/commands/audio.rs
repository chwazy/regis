use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::State;

use crate::AppState;
use regis_core::db::{repo, Db};
use regis_core::events::EventBus;
use regis_core::modules::require_voice_enabled;
use regis_voice::audio::capture::{new_backend, CaptureBackend};
use regis_voice::audio::dictation::{
    DictationConfig, DictationHost, DictationManager, DictationResult, EngineFuture,
    DEFAULT_MAX_SECONDS, SETTING_MAX_SECONDS,
};
use regis_voice::audio::recording::RecordingManager;
use regis_voice::audio::{
    devices, rms_level, AudioDevice, AudioFrame, AudioSource, TARGET_SAMPLE_RATE,
};
use regis_voice::stt::models::{find_model, DEFAULT_STT_MODEL};
use regis_voice::stt::state::SttStatus;
use regis_voice::stt::SttState;
use regis_voice::stt::SETTING_STT_MODEL;

const LEVEL_WINDOW_MS: u64 = 100;
const LEVEL_GRACE: Duration = Duration::from_secs(2);
const MAX_TEST_DURATION_MS: u64 = 30_000;

fn selected_model_id(state: &AppState) -> Result<String, String> {
    let stored = state
        .db
        .with_conn(|conn| repo::get_setting(conn, SETTING_STT_MODEL))
        .map_err(|error| error.to_string())?;
    Ok(devices::normalize_device_setting(stored).unwrap_or_else(|| DEFAULT_STT_MODEL.to_owned()))
}

async fn current_status(state: &AppState, model_id: String) -> Result<SttStatus, String> {
    let stt = state.stt.clone();
    let data_dir = state.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        stt.status(&data_dir, &model_id, regis_core::demo::is_enabled())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn audio_list_devices() -> Result<Vec<AudioDevice>, String> {
    tokio::task::spawn_blocking(devices::list_devices)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn audio_test_level(
    state: State<'_, AppState>,
    source: AudioSource,
    duration_ms: u64,
) -> Result<Vec<f32>, String> {
    let duration_ms = duration_ms.min(MAX_TEST_DURATION_MS);
    let device_id =
        devices::device_id_from_settings(&state.db, source).map_err(|error| error.to_string())?;
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AudioFrame>(64);
    let mut backend = new_backend();
    let started = tokio::task::spawn_blocking(move || {
        backend
            .start(source, device_id.as_deref(), tx)
            .map(|()| backend)
    })
    .await
    .map_err(|error| error.to_string())?;
    let mut backend = started.map_err(|error| error.to_string())?;

    let wanted_samples = duration_ms * u64::from(TARGET_SAMPLE_RATE) / 1000;
    let mut collected = 0u64;
    let mut levels = Vec::new();
    let _ = tokio::time::timeout(Duration::from_millis(duration_ms) + LEVEL_GRACE, async {
        while collected < wanted_samples {
            let Some(frame) = rx.recv().await else { break };
            collected += frame.samples.len() as u64;
            levels.push(rms_level(&frame.samples));
        }
    })
    .await;
    drop(rx);
    let _ = tokio::task::spawn_blocking(move || backend.stop()).await;
    levels.truncate((duration_ms / LEVEL_WINDOW_MS) as usize);
    Ok(levels)
}

#[tauri::command]
pub async fn stt_status(state: State<'_, AppState>) -> Result<SttStatus, String> {
    let model_id = selected_model_id(&state)?;
    current_status(&state, model_id).await
}

#[tauri::command]
pub async fn stt_download_model(
    state: State<'_, AppState>,
    model_id: String,
) -> Result<SttStatus, String> {
    let spec = find_model(&model_id).ok_or_else(|| format!("modèle inconnu : {model_id}"))?;
    if !regis_core::demo::is_enabled() {
        // L'échec est porté par l'état final (`error`), pas par une erreur de commande.
        let _ = state.stt.download(spec, &state.data_dir, &state.bus).await;
    }
    current_status(&state, model_id).await
}

struct AppDictationHost {
    db: Arc<Db>,
    stt: Arc<SttState>,
    data_dir: PathBuf,
    recording: RecordingManager,
}

impl DictationHost for AppDictationHost {
    fn config(&self) -> DictationConfig {
        let max_seconds = self
            .db
            .with_conn(|conn| repo::get_setting(conn, SETTING_MAX_SECONDS))
            .ok()
            .flatten()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|seconds| *seconds > 0)
            .unwrap_or(DEFAULT_MAX_SECONDS);
        DictationConfig {
            device_id: devices::device_id_from_settings(&self.db, AudioSource::Microphone)
                .ok()
                .flatten(),
            max_duration: Duration::from_secs(max_seconds),
        }
    }

    fn new_backend(&self) -> Box<dyn CaptureBackend> {
        new_backend()
    }

    fn recording_active(&self) -> bool {
        self.recording.is_recording()
    }

    fn engine(&self) -> EngineFuture {
        let db = self.db.clone();
        let stt = self.stt.clone();
        let data_dir = self.data_dir.clone();
        Box::pin(async move {
            let model_id = db
                .with_conn(|conn| repo::get_setting(conn, SETTING_STT_MODEL))
                .ok()
                .flatten();
            let model_id = devices::normalize_device_setting(model_id)
                .unwrap_or_else(|| DEFAULT_STT_MODEL.to_owned());
            stt.engine(&data_dir, &model_id, regis_core::demo::is_enabled())
                .await
        })
    }
}

pub fn build_dictation_manager(
    db: Arc<Db>,
    stt: Arc<SttState>,
    data_dir: PathBuf,
    bus: EventBus,
    recording: RecordingManager,
) -> DictationManager {
    DictationManager::new(
        bus,
        Arc::new(AppDictationHost {
            db,
            stt,
            data_dir,
            recording,
        }),
    )
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStarted {
    session_id: String,
}

#[tauri::command]
pub async fn dictation_start(state: State<'_, AppState>) -> Result<DictationStarted, String> {
    start_dictation(&state.db, &state.dictation)
}

fn start_dictation(db: &Db, dictation: &DictationManager) -> Result<DictationStarted, String> {
    require_voice_enabled(db).map_err(|error| error.to_string())?;
    dictation
        .start()
        .map(|session_id| DictationStarted { session_id })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dictation_stop(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<DictationResult, String> {
    state
        .dictation
        .stop(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dictation_cancel(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state
        .dictation
        .cancel(&session_id)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use regis_core::db::repo::testing::test_db;
    use regis_core::events::{EventSink, RegisEvent};

    struct NullSink;

    impl EventSink for NullSink {
        fn publish(&self, _event: RegisEvent) {}
    }

    #[test]
    fn dictation_start_is_refused_while_the_voice_module_is_disabled() {
        let db = Arc::new(test_db("dictation-voice-disabled"));
        let bus = EventBus::new(Arc::new(NullSink));
        let stt = Arc::new(SttState::new());
        let data_dir = std::env::temp_dir();
        let recording = crate::commands::recording::build_recording_manager(
            db.clone(),
            stt.clone(),
            data_dir.clone(),
            bus.clone(),
            None,
        );
        let dictation = build_dictation_manager(db.clone(), stt, data_dir, bus, recording);

        let error = start_dictation(&db, &dictation).expect_err("voice disabled");

        assert_eq!(error, "module désactivé : voice");
    }
}
