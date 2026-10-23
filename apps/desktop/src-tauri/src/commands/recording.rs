use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::State;

use crate::AppState;
use regis_core::db::{repo, Db};
use regis_core::events::EventBus;
use regis_core::modules::embeddings::active_embedder;
use regis_core::modules::require_voice_enabled;
use regis_model::{Recording, RecordingView, StartRecordingInput};
use regis_voice::audio::capture::{new_backend, CaptureBackend};
use regis_voice::audio::chunker::DEFAULT_CHUNK_SECONDS;
use regis_voice::audio::dictation::EngineFuture;
use regis_voice::audio::recording::{
    EmbedderFuture, NoIndicator, ReadyFuture, RecordingConfig, RecordingHost, RecordingIndicator,
    RecordingManager, DEFAULT_MAX_MINUTES, SETTING_CHUNK_SECONDS, SETTING_MAX_MINUTES,
};
use regis_voice::audio::{devices, AudioSource};
use regis_voice::stt::models::DEFAULT_STT_MODEL;
use regis_voice::stt::state::SttModelState;
use regis_voice::stt::{SttEngine, SttError, SttState};

use regis_voice::stt::SETTING_STT_MODEL;

/// En mode démo, le WAV de démonstration dure quelques secondes : des blocs courts donnent plusieurs blocs.
const DEMO_CHUNK_SECONDS: u32 = 2;

struct AppRecordingHost {
    db: Arc<Db>,
    stt: Arc<SttState>,
    data_dir: PathBuf,
}

impl AppRecordingHost {
    fn positive_setting(&self, key: &str) -> Option<u32> {
        self.db
            .with_conn(|conn| repo::get_setting(conn, key))
            .ok()
            .flatten()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .filter(|value| *value > 0)
    }
}

impl RecordingHost for AppRecordingHost {
    fn config(&self) -> RecordingConfig {
        let default_chunk = if regis_core::demo::is_enabled() {
            DEMO_CHUNK_SECONDS
        } else {
            DEFAULT_CHUNK_SECONDS
        };
        let device = |source| {
            devices::device_id_from_settings(&self.db, source)
                .ok()
                .flatten()
        };
        RecordingConfig {
            chunk_seconds: self
                .positive_setting(SETTING_CHUNK_SECONDS)
                .unwrap_or(default_chunk),
            max_duration: Duration::from_secs(
                u64::from(
                    self.positive_setting(SETTING_MAX_MINUTES)
                        .unwrap_or(DEFAULT_MAX_MINUTES),
                ) * 60,
            ),
            mic_device_id: device(AudioSource::Microphone),
            system_device_id: device(AudioSource::SystemLoopback),
        }
    }

    fn new_backend(&self, _source: AudioSource) -> Box<dyn CaptureBackend> {
        new_backend()
    }

    fn engine(&self) -> EngineFuture {
        let stt = self.stt.clone();
        let data_dir = self.data_dir.clone();
        let model_id = self.model_id();
        Box::pin(async move {
            let engine: Result<Arc<dyn SttEngine>, SttError> = stt
                .engine(&data_dir, &model_id, regis_core::demo::is_enabled())
                .await;
            engine
        })
    }

    fn model_ready(&self) -> ReadyFuture {
        let stt = self.stt.clone();
        let data_dir = self.data_dir.clone();
        let model_id = self.model_id();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                stt.status(&data_dir, &model_id, regis_core::demo::is_enabled())
                    .state
                    == SttModelState::Ready
            })
            .await
            .unwrap_or(false)
        })
    }

    fn model_id(&self) -> String {
        let stored = self
            .db
            .with_conn(|conn| repo::get_setting(conn, SETTING_STT_MODEL))
            .ok()
            .flatten();
        devices::normalize_device_setting(stored).unwrap_or_else(|| DEFAULT_STT_MODEL.to_owned())
    }

    fn loopback_supported(&self) -> bool {
        regis_voice::audio::is_loopback_supported()
    }

    fn embedder(&self) -> EmbedderFuture {
        let db = self.db.clone();
        Box::pin(async move { active_embedder(&db).await })
    }
}

pub fn build_recording_manager(
    db: Arc<Db>,
    stt: Arc<SttState>,
    data_dir: PathBuf,
    bus: EventBus,
    indicator: Option<Arc<dyn RecordingIndicator>>,
) -> RecordingManager {
    let host = Arc::new(AppRecordingHost {
        db: db.clone(),
        stt,
        data_dir: data_dir.clone(),
    });
    RecordingManager::new(
        db,
        data_dir,
        bus,
        host,
        indicator.unwrap_or_else(|| Arc::new(NoIndicator)),
    )
}

fn describe(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn recording_start(
    state: State<'_, AppState>,
    input: StartRecordingInput,
) -> Result<Recording, String> {
    start_recording(&state.db, &state.recording, input).await
}

async fn start_recording(
    db: &Db,
    recording: &RecordingManager,
    input: StartRecordingInput,
) -> Result<Recording, String> {
    require_voice_enabled(db).map_err(describe)?;
    recording.start(input).await.map_err(describe)
}

#[tauri::command]
pub async fn recording_stop(state: State<'_, AppState>, id: String) -> Result<Recording, String> {
    state.recording.stop(&id).await.map_err(describe)
}

#[tauri::command]
pub async fn recording_active(state: State<'_, AppState>) -> Result<Option<Recording>, String> {
    Ok(state.recording.active())
}

#[tauri::command]
pub async fn recording_get(
    state: State<'_, AppState>,
    transcript_item_id: String,
) -> Result<RecordingView, String> {
    state.recording.view(&transcript_item_id).map_err(describe)
}

#[tauri::command]
pub async fn recording_delete_audio(
    state: State<'_, AppState>,
    id: String,
) -> Result<Recording, String> {
    state.recording.delete_audio(&id).map_err(describe)
}

/// Un PV demande un job d'agent complet (jusqu'à deux essais) : bien au-delà du délai d'un appel RPC ordinaire.
const MINUTES_GENERATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[tauri::command]
pub async fn minutes_generate(
    state: State<'_, AppState>,
    transcript_item_id: String,
) -> Result<regis_model::Item, String> {
    state
        .sidecar
        .call_with_timeout(
            "minutes.generate",
            serde_json::json!({ "transcriptItemId": transcript_item_id }),
            MINUTES_GENERATE_TIMEOUT,
        )
        .await
        .map_err(describe)
}

#[tauri::command]
pub async fn minutes_get(
    state: State<'_, AppState>,
    transcript_item_id: String,
) -> Result<Option<regis_model::Item>, String> {
    state
        .db
        .with_conn(|conn| repo::minutes::find_minutes(conn, &transcript_item_id))
        .map_err(describe)
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinutesExportResult {
    pub file_ids: Vec<String>,
}

#[tauri::command]
pub async fn minutes_export(
    state: State<'_, AppState>,
    minutes_item_id: String,
    template_id: String,
) -> Result<MinutesExportResult, String> {
    state
        .sidecar
        .call(
            "minutes.export",
            serde_json::json!({ "minutesItemId": minutes_item_id, "templateId": template_id }),
        )
        .await
        .map_err(describe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use regis_core::db::repo::testing::test_db;
    use regis_core::events::{EventSink, RegisEvent};
    use regis_model::RecordingSources;

    struct NullSink;

    impl EventSink for NullSink {
        fn publish(&self, _event: RegisEvent) {}
    }

    #[tokio::test]
    async fn recording_start_is_refused_while_the_voice_module_is_disabled() {
        let db = Arc::new(test_db("recording-voice-disabled"));
        let recording = build_recording_manager(
            db.clone(),
            Arc::new(SttState::new()),
            std::env::temp_dir(),
            EventBus::new(Arc::new(NullSink)),
            None,
        );
        let input = StartRecordingInput {
            title: None,
            sources: RecordingSources::Mic,
            event_item_id: None,
            entity_id: None,
            consent_confirmed: true,
            consent_text: "consentement".to_owned(),
        };

        let error = start_recording(&db, &recording, input)
            .await
            .expect_err("voice disabled");

        assert_eq!(error, "module désactivé : voice");
    }
}
