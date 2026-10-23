use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::Receiver;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use ts_rs::TS;

use super::capture::CaptureBackend;
use super::{rms_level, AudioError, AudioFrame, AudioSource, TARGET_SAMPLE_RATE};
use crate::stt::{transcribe_blocking, SttEngine, SttError, TranscribeOptions};
use regis_core::events::EventBus;

pub const SETTING_MAX_SECONDS: &str = "dictation.maxSeconds";
pub const DEFAULT_MAX_SECONDS: u64 = 120;
pub const LEVEL_TOPIC: &str = "dictation.level";
pub const AUTO_STOPPED_TOPIC: &str = "dictation.autoStopped";

/// RMS moyen du tampon sous lequel on ne transcrit pas (whisper hallucine sur le silence).
/// Bruit de fond d'un micro de bureau ≈ 0.001–0.003 ; voix normale ≥ 0.02 en moyenne.
pub const SILENCE_RMS: f32 = 0.004;

const LEVEL_INTERVAL: Duration = Duration::from_millis(100);
const FRAME_CHANNEL_CAPACITY: usize = 64;
const DICTATION_LANGUAGE: &str = "fr";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DictationResult {
    pub session_id: String,
    pub text: String,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub auto_stopped: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum DictationError {
    #[error("une dictée est déjà en cours")]
    AlreadyRunning,
    #[error("session de dictée inconnue : {0}")]
    UnknownSession(String),
    #[error("micro indisponible pendant un enregistrement de réunion")]
    RecordingActive,
    #[error(transparent)]
    Audio(#[from] AudioError),
    #[error(transparent)]
    Stt(#[from] SttError),
}

pub struct DictationConfig {
    pub device_id: Option<String>,
    pub max_duration: Duration,
}

pub type EngineFuture = Pin<Box<dyn Future<Output = Result<Arc<dyn SttEngine>, SttError>> + Send>>;

/// Dépendances externes de la dictée (réglages, micro, moteur) : injectées pour les tests.
pub trait DictationHost: Send + Sync {
    fn config(&self) -> DictationConfig;
    fn new_backend(&self) -> Box<dyn CaptureBackend>;
    fn engine(&self) -> EngineFuture;
    /// Vrai pendant un enregistrement de réunion (le micro lui est réservé).
    fn recording_active(&self) -> bool {
        false
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelPayload<'a> {
    session_id: &'a str,
    rms: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionPayload<'a> {
    session_id: &'a str,
}

struct Collected {
    samples: Vec<f32>,
    auto_stopped: bool,
}

struct ActiveDictation {
    session_id: String,
    stop_tx: oneshot::Sender<()>,
    task: JoinHandle<Collected>,
}

pub struct DictationManager {
    active: Mutex<Option<ActiveDictation>>,
    bus: EventBus,
    host: Arc<dyn DictationHost>,
}

impl DictationManager {
    pub fn new(bus: EventBus, host: Arc<dyn DictationHost>) -> DictationManager {
        DictationManager {
            active: Mutex::new(None),
            bus,
            host,
        }
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<ActiveDictation>> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Doit être appelé dans un contexte runtime tokio.
    pub fn start(&self) -> Result<String, DictationError> {
        if self.host.recording_active() {
            return Err(DictationError::RecordingActive);
        }
        let mut slot = self.slot();
        if slot.is_some() {
            return Err(DictationError::AlreadyRunning);
        }
        let config = self.host.config();
        let mut backend = self.host.new_backend();
        let (tx, rx) = tokio::sync::mpsc::channel::<AudioFrame>(FRAME_CHANNEL_CAPACITY);
        backend.start(AudioSource::Microphone, config.device_id.as_deref(), tx)?;
        let session_id = ulid::Ulid::generate().to_string();
        let (stop_tx, stop_rx) = oneshot::channel();
        let task = tokio::spawn(collect(
            backend,
            rx,
            stop_rx,
            config.max_duration,
            self.bus.clone(),
            session_id.clone(),
        ));
        *slot = Some(ActiveDictation {
            session_id: session_id.clone(),
            stop_tx,
            task,
        });
        Ok(session_id)
    }

    fn take(&self, session_id: &str) -> Result<ActiveDictation, DictationError> {
        let mut slot = self.slot();
        match slot.take() {
            Some(active) if active.session_id == session_id => Ok(active),
            other => {
                *slot = other;
                Err(DictationError::UnknownSession(session_id.to_owned()))
            }
        }
    }

    pub async fn stop(&self, session_id: &str) -> Result<DictationResult, DictationError> {
        let active = self.take(session_id)?;
        let _ = active.stop_tx.send(());
        let collected = active
            .task
            .await
            .map_err(|error| AudioError::Stream(error.to_string()))?;
        let duration_ms = collected.samples.len() as u64 * 1000 / u64::from(TARGET_SAMPLE_RATE);
        let text = if is_silent(&collected.samples) {
            String::new()
        } else {
            let engine = self.host.engine().await?;
            let options = TranscribeOptions {
                language: DICTATION_LANGUAGE.to_owned(),
                initial_prompt: None,
            };
            let segments = transcribe_blocking(engine, collected.samples, options).await?;
            join_segments(segments.iter().map(|segment| segment.text.as_str()))
        };
        Ok(DictationResult {
            session_id: session_id.to_owned(),
            text,
            duration_ms,
            auto_stopped: collected.auto_stopped,
        })
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), DictationError> {
        let active = self.take(session_id)?;
        // La tâche se termine seule et libère le tampon sans le transcrire.
        let _ = active.stop_tx.send(());
        Ok(())
    }
}

pub fn is_silent(samples: &[f32]) -> bool {
    rms_level(samples) < SILENCE_RMS
}

fn join_segments<'a>(texts: impl Iterator<Item = &'a str>) -> String {
    texts
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

async fn collect(
    mut backend: Box<dyn CaptureBackend>,
    mut rx: Receiver<AudioFrame>,
    mut stop_rx: oneshot::Receiver<()>,
    max_duration: Duration,
    bus: EventBus,
    session_id: String,
) -> Collected {
    let max_samples = (max_duration.as_secs_f64() * f64::from(TARGET_SAMPLE_RATE)) as usize;
    let deadline = Instant::now() + max_duration;
    let mut samples: Vec<f32> = Vec::new();
    let mut auto_stopped = false;
    let mut source_closed = false;
    let mut window_peak = 0f32;
    let mut ticker = tokio::time::interval(LEVEL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut stop_rx => break,
            _ = tokio::time::sleep_until(deadline) => {
                auto_stopped = true;
                break;
            }
            _ = ticker.tick() => {
                bus.emit(LEVEL_TOPIC, &LevelPayload { session_id: &session_id, rms: window_peak });
                window_peak = 0.0;
            }
            frame = rx.recv(), if !source_closed => match frame {
                Some(frame) => {
                    window_peak = window_peak.max(rms_level(&frame.samples));
                    samples.extend_from_slice(&frame.samples);
                    if samples.len() >= max_samples {
                        auto_stopped = true;
                        break;
                    }
                }
                None => source_closed = true,
            },
        }
    }
    if auto_stopped {
        bus.emit(
            AUTO_STOPPED_TOPIC,
            &SessionPayload {
                session_id: &session_id,
            },
        );
    }
    let _ = tokio::task::spawn_blocking(move || backend.stop()).await;
    while let Ok(frame) = rx.try_recv() {
        samples.extend_from_slice(&frame.samples);
    }
    samples.truncate(max_samples);
    Collected {
        samples,
        auto_stopped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::capture::{demo_fixture_path, WavFileBackend};
    use crate::stt::{FakeSttEngine, SttSegment, DEMO_TRANSCRIPT};
    use regis_core::events::{EventSink, RegisEvent};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingEngine {
        calls: Arc<AtomicUsize>,
        inner: FakeSttEngine,
    }

    impl SttEngine for CountingEngine {
        fn transcribe(
            &self,
            samples: &[f32],
            opts: &TranscribeOptions,
        ) -> Result<Vec<SttSegment>, SttError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.inner.transcribe(samples, opts)
        }
    }

    /// Envoie un seul bloc de valeurs constantes puis garde le flux ouvert.
    struct ConstantBackend {
        value: f32,
        keep_open: Option<tokio::sync::mpsc::Sender<AudioFrame>>,
    }

    impl CaptureBackend for ConstantBackend {
        fn start(
            &mut self,
            source: AudioSource,
            _device_id: Option<&str>,
            tx: tokio::sync::mpsc::Sender<AudioFrame>,
        ) -> Result<(), AudioError> {
            let _ = tx.try_send(AudioFrame {
                source,
                samples: vec![self.value; 16_000],
                offset_ms: 0,
            });
            self.keep_open = Some(tx);
            Ok(())
        }
        fn stop(&mut self) {
            self.keep_open = None;
        }
    }

    struct TestHost {
        calls: Arc<AtomicUsize>,
        max_duration: Duration,
        constant: Option<f32>,
        recording: bool,
    }

    impl TestHost {
        fn new(max_seconds: u64) -> (Arc<TestHost>, Arc<AtomicUsize>) {
            let calls = Arc::new(AtomicUsize::new(0));
            let host = Arc::new(TestHost {
                calls: calls.clone(),
                max_duration: Duration::from_secs(max_seconds),
                constant: None,
                recording: false,
            });
            (host, calls)
        }
    }

    impl DictationHost for TestHost {
        fn config(&self) -> DictationConfig {
            DictationConfig {
                device_id: None,
                max_duration: self.max_duration,
            }
        }
        fn new_backend(&self) -> Box<dyn CaptureBackend> {
            match self.constant {
                Some(value) => Box::new(ConstantBackend {
                    value,
                    keep_open: None,
                }),
                None => Box::new(WavFileBackend::new(demo_fixture_path())),
            }
        }
        fn engine(&self) -> EngineFuture {
            let engine: Arc<dyn SttEngine> = Arc::new(CountingEngine {
                calls: self.calls.clone(),
                inner: FakeSttEngine::demo(),
            });
            Box::pin(async move { Ok(engine) })
        }
        fn recording_active(&self) -> bool {
            self.recording
        }
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<RegisEvent>>);

    impl EventSink for Recorder {
        fn publish(&self, event: RegisEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn manager(host: Arc<TestHost>) -> (DictationManager, Arc<Recorder>) {
        let recorder = Arc::new(Recorder::default());
        let bus = EventBus::new(recorder.clone());
        (DictationManager::new(bus, host), recorder)
    }

    async fn let_audio_flow() {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    #[test]
    fn fixture_is_far_above_the_silence_threshold() {
        let mut reader = hound::WavReader::open(demo_fixture_path()).unwrap();
        let samples: Vec<f32> = reader
            .samples::<i16>()
            .map(|s| f32::from(s.unwrap()) / 32768.0)
            .collect();
        let level = rms_level(&samples);
        assert!(level > SILENCE_RMS * 3.0, "{level}");
        assert!(is_silent(&vec![0.0; 16_000]));
        assert!(is_silent(&vec![0.001; 16_000]));
        assert!(!is_silent(&vec![0.02; 16_000]));
    }

    #[tokio::test]
    async fn start_then_stop_returns_the_engine_text() {
        let (host, calls) = TestHost::new(120);
        let (manager, _) = manager(host);
        let id = manager.start().unwrap();
        let_audio_flow().await;
        let result = manager.stop(&id).await.unwrap();
        assert_eq!(result.text, DEMO_TRANSCRIPT);
        assert_eq!(result.session_id, id);
        assert!(!result.auto_stopped);
        assert!(result.duration_ms > 1_000);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn dictation_is_refused_while_a_meeting_is_recorded() {
        let host = Arc::new(TestHost {
            calls: Arc::new(AtomicUsize::new(0)),
            max_duration: Duration::from_secs(120),
            constant: None,
            recording: true,
        });
        let (manager, _) = manager(host);
        assert!(matches!(
            manager.start(),
            Err(DictationError::RecordingActive)
        ));
    }

    #[tokio::test]
    async fn second_start_is_refused_and_unknown_id_is_reported() {
        let (host, _) = TestHost::new(120);
        let (manager, _) = manager(host);
        let id = manager.start().unwrap();
        assert!(matches!(
            manager.start(),
            Err(DictationError::AlreadyRunning)
        ));
        assert!(matches!(
            manager.stop("inconnu").await,
            Err(DictationError::UnknownSession(_))
        ));
        manager.cancel(&id).unwrap();
    }

    #[tokio::test]
    async fn session_stops_by_itself_at_the_maximum_duration() {
        let (host, _) = TestHost::new(1);
        let (manager, recorder) = manager(host);
        let id = manager.start().unwrap();
        let_audio_flow().await;
        assert!(recorder
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.topic == AUTO_STOPPED_TOPIC));
        let result = manager.stop(&id).await.unwrap();
        assert!(result.auto_stopped);
        assert_eq!(result.text, DEMO_TRANSCRIPT);
        assert!(result.duration_ms <= 1_000);
    }

    #[tokio::test]
    async fn cancel_never_transcribes_and_forgets_the_session() {
        let (host, calls) = TestHost::new(120);
        let (manager, _) = manager(host);
        let id = manager.start().unwrap();
        let_audio_flow().await;
        manager.cancel(&id).unwrap();
        assert!(matches!(
            manager.stop(&id).await,
            Err(DictationError::UnknownSession(_))
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let again = manager.start().unwrap();
        manager.cancel(&again).unwrap();
    }

    #[tokio::test]
    async fn silence_returns_empty_text_without_calling_the_engine() {
        let calls = Arc::new(AtomicUsize::new(0));
        let host = Arc::new(TestHost {
            calls: calls.clone(),
            max_duration: Duration::from_secs(120),
            constant: Some(0.0),
            recording: false,
        });
        let (manager, _) = manager(host);
        let id = manager.start().unwrap();
        let_audio_flow().await;
        let result = manager.stop(&id).await.unwrap();
        assert_eq!(result.text, "");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn level_events_are_published_while_listening() {
        let (host, _) = TestHost::new(120);
        let (manager, recorder) = manager(host);
        let id = manager.start().unwrap();
        let_audio_flow().await;
        manager.cancel(&id).unwrap();
        let events = recorder.0.lock().unwrap();
        let level = events
            .iter()
            .find(|event| event.topic == LEVEL_TOPIC)
            .expect("level event");
        assert_eq!(level.payload["sessionId"], id.as_str());
        assert!(level.payload["rms"].is_number());
    }

    fn listing(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut found = Vec::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(current) = pending.pop() {
            for entry in std::fs::read_dir(current).unwrap().flatten() {
                found.push(entry.path());
                if entry.path().is_dir() {
                    pending.push(entry.path());
                }
            }
        }
        found.sort();
        found
    }

    #[tokio::test]
    async fn no_file_is_created_in_the_data_dir_during_a_dictation() {
        let data_dir =
            std::env::temp_dir().join(format!("regis-dictation-{}", ulid::Ulid::generate()));
        std::fs::create_dir_all(&data_dir).unwrap();
        let before = listing(&data_dir);
        let (host, _) = TestHost::new(120);
        let (manager, _) = manager(host);
        let id = manager.start().unwrap();
        let_audio_flow().await;
        manager.stop(&id).await.unwrap();
        assert_eq!(listing(&data_dir), before);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn segments_are_joined_with_single_spaces() {
        assert_eq!(join_segments([" a ", "", "b"].into_iter()), "a b");
    }
}
