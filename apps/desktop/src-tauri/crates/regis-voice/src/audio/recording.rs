use std::io::BufWriter;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tokio::sync::mpsc::{Receiver, UnboundedReceiver, UnboundedSender};
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::capture::CaptureBackend;
use super::chunker::{is_silent, pick_cut_point};
use super::dictation::EngineFuture;
use super::transcript::render_transcript;
use super::{rms_level, AudioError, AudioFrame, AudioSource, TARGET_SAMPLE_RATE};
use crate::stt::{transcribe_blocking, SttEngine, SttError, TranscribeOptions};
use regis_core::db::repo::recordings::{self as store, RecordingRow};
use regis_core::db::repo::{self, RepoError};
use regis_core::db::Db;
use regis_core::events::{iso_utc, now_iso_utc, EventBus};
use regis_core::files::embed::OllamaEmbedder;
use regis_core::files::indexer::{index_item_text, replace_item_chunks};
use regis_model::{
    Entity, Item, ItemKind, Recording, RecordingStatus, RecordingView, SegmentSource,
    StartRecordingInput, TranscriptSegment,
};

pub const SETTING_CHUNK_SECONDS: &str = "recording.chunkSeconds";
pub const SETTING_MAX_MINUTES: &str = "recording.maxMinutes";
pub const SETTING_RETENTION_DAYS: &str = "audio.retentionDays";
pub const DEFAULT_MAX_MINUTES: u32 = 240;
pub const DEFAULT_RETENTION_DAYS: u32 = 30;
/// Relatif à `data_dir` ; seul dossier où l'enregistrement écrit et où la purge supprime.
pub const RECORDINGS_RELATIVE_DIR: &str = "library/generated/recordings";

pub const STATE_TOPIC: &str = "recording.state";
pub const SEGMENT_TOPIC: &str = "recording.segment";
pub const LEVEL_TOPIC: &str = "recording.level";
pub const BACKLOG_TOPIC: &str = "recording.backlog";

const DEFAULT_TITLE: &str = "Enregistrement";
const INTERRUPTED_MESSAGE: &str = "Interrompu";
const LANGUAGE: &str = "fr";
const LEVEL_INTERVAL: Duration = Duration::from_millis(100);
const FRAME_CHANNEL_CAPACITY: usize = 64;
const WINDOW_SAMPLES: usize = (TARGET_SAMPLE_RATE / 10) as usize;
const SECONDS_PER_DAY: u64 = 86_400;
/// En dessous (0,5 s), un bloc n'est pas transcrit : whisper n'y trouve que des hallucinations.
const MIN_BLOCK_SAMPLES: usize = (TARGET_SAMPLE_RATE / 2) as usize;

#[derive(Debug, thiserror::Error)]
pub enum RecordingError {
    #[error("consentement non confirmé")]
    ConsentRequired,
    #[error("un enregistrement est déjà en cours")]
    AlreadyRecording,
    #[error("enregistrement inconnu : {0}")]
    NotFound(String),
    #[error("source non prise en charge sur cette plateforme : {0}")]
    UnsupportedSource(String),
    #[error("modèle de transcription non prêt")]
    ModelNotReady,
    #[error(transparent)]
    Audio(#[from] AudioError),
    #[error(transparent)]
    Stt(#[from] SttError),
    #[error(transparent)]
    Repo(#[from] RepoError),
}

fn repo_error(error: RepoError) -> RecordingError {
    match error {
        RepoError::NotFound(what) => RecordingError::NotFound(what),
        other => RecordingError::Repo(other),
    }
}

pub struct RecordingConfig {
    pub chunk_seconds: u32,
    pub max_duration: Duration,
    pub mic_device_id: Option<String>,
    pub system_device_id: Option<String>,
}

pub type ReadyFuture = std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>;
pub type EmbedderFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Option<OllamaEmbedder>> + Send>>;

/// Dépendances externes de l'enregistrement (réglages, périphériques, moteur) : injectées pour les tests.
pub trait RecordingHost: Send + Sync {
    fn config(&self) -> RecordingConfig;
    fn new_backend(&self, source: AudioSource) -> Box<dyn CaptureBackend>;
    fn engine(&self) -> EngineFuture;
    fn model_ready(&self) -> ReadyFuture;
    fn model_id(&self) -> String;
    fn loopback_supported(&self) -> bool;
    fn embedder(&self) -> EmbedderFuture;
}

/// Signal visible pendant la session (tray, titre de fenêtre) : créé au démarrage, retiré à la fin.
pub trait RecordingIndicator: Send + Sync {
    fn show(&self, recording: &Recording);
    fn hide(&self);
}

pub struct NoIndicator;

impl RecordingIndicator for NoIndicator {
    fn show(&self, _recording: &Recording) {}
    fn hide(&self) {}
}

struct Job {
    source: SegmentSource,
    offset_ms: u64,
    samples: Vec<f32>,
}

struct Shared {
    id: String,
    bus: EventBus,
    pending: Arc<AtomicU32>,
    failed_blocks: AtomicU32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SegmentPayload<'a> {
    recording_id: &'a str,
    segment: &'a TranscriptSegment,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelPayload<'a> {
    recording_id: &'a str,
    mic: Option<f32>,
    system: Option<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BacklogPayload<'a> {
    recording_id: &'a str,
    pending_chunks: u32,
}

impl Shared {
    fn enqueue(&self) {
        let pending = self.pending.fetch_add(1, Ordering::SeqCst) + 1;
        self.emit_backlog(pending);
    }

    fn complete(&self) {
        let pending = self
            .pending
            .fetch_sub(1, Ordering::SeqCst)
            .saturating_sub(1);
        self.emit_backlog(pending);
    }

    fn emit_backlog(&self, pending_chunks: u32) {
        self.bus.emit(
            BACKLOG_TOPIC,
            &BacklogPayload {
                recording_id: &self.id,
                pending_chunks,
            },
        );
    }
}

struct Active {
    recording: Recording,
    pending: Arc<AtomicU32>,
    stop_tx: Option<oneshot::Sender<()>>,
    done: watch::Receiver<Option<Recording>>,
}

struct Inner {
    db: Arc<Db>,
    data_dir: PathBuf,
    bus: EventBus,
    host: Arc<dyn RecordingHost>,
    indicator: Arc<dyn RecordingIndicator>,
    active: Mutex<Option<Active>>,
    starting: AtomicBool,
}

impl Inner {
    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Active>> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn publish(&self, recording: &Recording) {
        self.bus.emit(STATE_TOPIC, recording);
    }
}

#[derive(Clone)]
pub struct RecordingManager {
    inner: Arc<Inner>,
}

struct StartingGuard<'a>(&'a AtomicBool);

impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

type Writer = hound::WavWriter<BufWriter<std::fs::File>>;

struct SourcePlan {
    kind: SegmentSource,
    backend: Box<dyn CaptureBackend>,
    rx: Receiver<AudioFrame>,
    writer: Writer,
}

fn wav_spec() -> hound::WavSpec {
    hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    }
}

fn file_error(error: impl std::fmt::Display) -> AudioError {
    AudioError::File(error.to_string())
}

fn sample_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16
}

impl RecordingManager {
    pub fn new(
        db: Arc<Db>,
        data_dir: PathBuf,
        bus: EventBus,
        host: Arc<dyn RecordingHost>,
        indicator: Arc<dyn RecordingIndicator>,
    ) -> RecordingManager {
        RecordingManager {
            inner: Arc::new(Inner {
                db,
                data_dir,
                bus,
                host,
                indicator,
                active: Mutex::new(None),
                starting: AtomicBool::new(false),
            }),
        }
    }

    pub fn active(&self) -> Option<Recording> {
        self.inner
            .slot()
            .as_ref()
            .map(|active| active.recording.clone())
    }

    /// Vrai tant que le micro est capturé (la finalisation ne compte plus).
    pub fn is_recording(&self) -> bool {
        self.active()
            .is_some_and(|recording| recording.status == RecordingStatus::Recording)
    }

    pub async fn start(&self, input: StartRecordingInput) -> Result<Recording, RecordingError> {
        if !input.consent_confirmed || input.consent_text.trim().is_empty() {
            return Err(RecordingError::ConsentRequired);
        }
        if self.inner.starting.swap(true, Ordering::SeqCst) || self.inner.slot().is_some() {
            return Err(RecordingError::AlreadyRecording);
        }
        let _guard = StartingGuard(&self.inner.starting);
        self.start_session(input).await
    }

    async fn start_session(&self, input: StartRecordingInput) -> Result<Recording, RecordingError> {
        let inner = &self.inner;
        if input.sources.includes_system() && !inner.host.loopback_supported() {
            return Err(RecordingError::UnsupportedSource("son système".to_owned()));
        }
        if !inner.host.model_ready().await {
            return Err(RecordingError::ModelNotReady);
        }
        let engine = inner.host.engine().await?;
        let config = inner.host.config();
        let event = match &input.event_item_id {
            Some(event_id) => Some(
                inner
                    .db
                    .with_conn(|conn| {
                        let item = repo::get::<Item>(conn, event_id)?
                            .ok_or_else(|| RepoError::NotFound(format!("items {event_id}")))?;
                        if item.kind != ItemKind::Event {
                            return Err(RepoError::Invalid(
                                "l'élément n'est pas un événement".to_owned(),
                            ));
                        }
                        Ok(item)
                    })
                    .map_err(repo_error)?,
            ),
            None => None,
        };
        if let Some(entity_id) = &input.entity_id {
            inner
                .db
                .with_conn(|conn| repo::require::<Entity>(conn, entity_id).map(|_| ()))
                .map_err(repo_error)?;
        }

        let id = repo::new_id();
        let relative = format!("{RECORDINGS_RELATIVE_DIR}/{id}");
        let directory = inner.data_dir.join(&relative);
        std::fs::create_dir_all(&directory).map_err(file_error)?;
        let plans = match self.open_sources(&input, &directory, &config).await {
            Ok(plans) => plans,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&directory);
                return Err(error);
            }
        };

        let started_at = now_iso_utc();
        let title = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_owned)
            .or_else(|| event.as_ref().map(|item| item.title.clone()))
            .unwrap_or_else(|| DEFAULT_TITLE.to_owned());
        let row = RecordingRow {
            id: id.clone(),
            title,
            status: RecordingStatus::Recording,
            sources: input.sources,
            started_at: started_at.clone(),
            ended_at: None,
            duration_ms: None,
            consent_at: started_at,
            consent_text: input.consent_text.clone(),
            stt_model: inner.host.model_id(),
            audio_dir: Some(relative),
            audio_purged_at: None,
            error: None,
        };
        let created = inner.db.with_conn(|conn| {
            store::insert_recording(conn, &row)?;
            let note = store::create_transcript_note(conn, &row)?;
            store::insert_link(
                conn,
                ("recording", &row.id),
                ("item", &note.id),
                store::REL_PRODUCED,
                "auto",
            )?;
            if let Some(event) = &event {
                store::insert_link(
                    conn,
                    ("item", &note.id),
                    ("item", &event.id),
                    store::REL_ABOUT,
                    "auto",
                )?;
            }
            link_event_entities(conn, &note.id, event.as_ref())?;
            if let Some(entity_id) = &input.entity_id {
                store::insert_link(
                    conn,
                    ("item", &note.id),
                    ("entity", entity_id),
                    store::REL_ABOUT,
                    "user",
                )?;
            }
            Ok(note.id)
        });
        let note_id = match created {
            Ok(note_id) => note_id,
            Err(error) => {
                stop_plans(plans).await;
                let _ = std::fs::remove_dir_all(&directory);
                let _ = inner
                    .db
                    .with_conn(|conn| store::delete_recording(conn, &row.id));
                return Err(repo_error(error));
            }
        };

        let recording = row.to_recording();
        let pending = Arc::new(AtomicU32::new(0));
        let (stop_tx, stop_rx) = oneshot::channel();
        let (done_tx, done_rx) = watch::channel(None);
        *inner.slot() = Some(Active {
            recording: recording.clone(),
            pending: pending.clone(),
            stop_tx: Some(stop_tx),
            done: done_rx,
        });
        inner.indicator.show(&recording);
        inner.publish(&recording);

        let session = Session {
            inner: inner.clone(),
            row,
            note_id,
            chunk_seconds: config.chunk_seconds.max(1),
            max_duration: config.max_duration,
            engine,
            shared: Arc::new(Shared {
                id,
                bus: inner.bus.clone(),
                pending,
                failed_blocks: AtomicU32::new(0),
            }),
            plans,
            stop_rx,
        };
        tokio::spawn(supervise(session, done_tx));
        Ok(recording)
    }

    async fn open_sources(
        &self,
        input: &StartRecordingInput,
        directory: &Path,
        config: &RecordingConfig,
    ) -> Result<Vec<SourcePlan>, RecordingError> {
        let mut wanted: Vec<(SegmentSource, AudioSource, &str, Option<String>)> = Vec::new();
        if input.sources.includes_mic() {
            wanted.push((
                SegmentSource::Mic,
                AudioSource::Microphone,
                "mic.wav",
                config.mic_device_id.clone(),
            ));
        }
        if input.sources.includes_system() {
            wanted.push((
                SegmentSource::System,
                AudioSource::SystemLoopback,
                "system.wav",
                config.system_device_id.clone(),
            ));
        }
        let mut plans: Vec<SourcePlan> = Vec::new();
        for (kind, audio, file_name, device_id) in wanted {
            let writer =
                hound::WavWriter::create(directory.join(file_name), wav_spec()).map_err(file_error);
            let writer = match writer {
                Ok(writer) => writer,
                Err(error) => {
                    stop_plans(plans).await;
                    return Err(error.into());
                }
            };
            let (tx, rx) = tokio::sync::mpsc::channel::<AudioFrame>(FRAME_CHANNEL_CAPACITY);
            let mut backend = self.inner.host.new_backend(audio);
            let started = tokio::task::spawn_blocking(move || {
                backend
                    .start(audio, device_id.as_deref(), tx)
                    .map(|()| backend)
            })
            .await
            .map_err(|error| AudioError::Stream(error.to_string()))
            .and_then(|result| result);
            match started {
                Ok(backend) => plans.push(SourcePlan {
                    kind,
                    backend,
                    rx,
                    writer,
                }),
                Err(error) => {
                    stop_plans(plans).await;
                    return Err(error.into());
                }
            }
        }
        Ok(plans)
    }

    /// Passe par `finalizing` et attend la fin de la file de transcription.
    pub async fn stop(&self, id: &str) -> Result<Recording, RecordingError> {
        let waiting = {
            let mut slot = self.inner.slot();
            match slot.as_mut().filter(|active| active.recording.id == id) {
                Some(active) => {
                    if let Some(stop_tx) = active.stop_tx.take() {
                        let _ = stop_tx.send(());
                    }
                    Some(active.done.clone())
                }
                None => None,
            }
        };
        let Some(mut done) = waiting else {
            let row = self
                .inner
                .db
                .with_conn(|conn| store::require_recording(conn, id))
                .map_err(repo_error)?;
            return Ok(row.to_recording());
        };
        loop {
            if let Some(recording) = done.borrow().clone() {
                return Ok(recording);
            }
            if done.changed().await.is_err() {
                return Err(AudioError::Stream("session interrompue".to_owned()).into());
            }
        }
    }

    /// `id` : identifiant de la note transcript, ou à défaut celui de l'enregistrement.
    pub fn view(&self, id: &str) -> Result<RecordingView, RecordingError> {
        let view = self
            .inner
            .db
            .with_conn(|conn| {
                let row = match store::recording_of_transcript(conn, id)? {
                    Some(row) => row,
                    None => store::require_recording(conn, id)?,
                };
                let transcript_item_id = store::transcript_item_id(conn, &row.id)?
                    .ok_or_else(|| RepoError::NotFound(format!("transcript de {}", row.id)))?;
                Ok(RecordingView {
                    segments: store::list_segments(conn, &row.id)?,
                    event_item_id: store::event_of_transcript(conn, &transcript_item_id)?,
                    transcript_item_id,
                    pending_chunks: 0,
                    recording: row.to_recording(),
                })
            })
            .map_err(repo_error)?;
        let pending = self
            .inner
            .slot()
            .as_ref()
            .filter(|active| active.recording.id == view.recording.id)
            .map_or(0, |active| active.pending.load(Ordering::SeqCst));
        Ok(RecordingView {
            pending_chunks: pending,
            ..view
        })
    }

    /// « Supprimer l'audio maintenant » : refusé tant que la session n'est pas terminée.
    pub fn delete_audio(&self, id: &str) -> Result<Recording, RecordingError> {
        let inner = &self.inner;
        let row = inner
            .db
            .with_conn(|conn| store::require_recording(conn, id))
            .map_err(repo_error)?;
        if matches!(
            row.status,
            RecordingStatus::Recording | RecordingStatus::Finalizing
        ) {
            return Err(RecordingError::AlreadyRecording);
        }
        if let Some(audio_dir) = &row.audio_dir {
            remove_recording_audio(&inner.data_dir, audio_dir)?;
        }
        inner
            .db
            .with_conn(|conn| store::mark_audio_purged(conn, id, &now_iso_utc()))?;
        let updated = inner
            .db
            .with_conn(|conn| store::require_recording(conn, id))?
            .to_recording();
        inner.publish(&updated);
        Ok(updated)
    }

    /// Au démarrage de l'app : toute session `recording` ou `finalizing` devient `failed`
    /// et son transcript est rendu à partir des segments déjà en base.
    pub fn recover_interrupted(db: &Db) -> Result<u32, RecordingError> {
        let rows = db.with_conn(|conn| {
            store::list_recordings_with_status(
                conn,
                &[RecordingStatus::Recording, RecordingStatus::Finalizing],
            )
        })?;
        for row in &rows {
            db.with_conn(|conn| {
                let segments = store::list_segments(conn, &row.id)?;
                let duration = segments
                    .iter()
                    .map(|segment| segment.end_ms)
                    .max()
                    .unwrap_or(0);
                store::finish_recording(
                    conn,
                    &row.id,
                    RecordingStatus::Failed,
                    &now_iso_utc(),
                    duration,
                    Some(INTERRUPTED_MESSAGE),
                )?;
                if let Some(note_id) = store::transcript_item_id(conn, &row.id)? {
                    let body = render_transcript(&segments);
                    let data = store::transcript_data(
                        &row.started_at,
                        Some(duration),
                        &row.stt_model,
                        "failed",
                    );
                    store::update_transcript_note(conn, &note_id, &body, &data)?;
                    let chunks = regis_core::files::chunk::chunk_text(
                        &body,
                        regis_core::files::chunk::DEFAULT_TARGET,
                        regis_core::files::chunk::DEFAULT_OVERLAP,
                    );
                    replace_item_chunks(conn, &note_id, &chunks, None)?;
                }
                Ok(())
            })?;
        }
        Ok(rows.len() as u32)
    }

    /// Supprime le dossier audio des enregistrements terminés avant `now - retention_days`.
    pub fn purge_expired_audio(
        db: &Db,
        data_dir: &Path,
        retention_days: u32,
        now: SystemTime,
    ) -> Result<u32, RecordingError> {
        let window = Duration::from_secs(u64::from(retention_days) * SECONDS_PER_DAY);
        let cutoff = iso_utc(now.checked_sub(window).unwrap_or(SystemTime::UNIX_EPOCH));
        let candidates = db.with_conn(|conn| store::list_purge_candidates(conn, &cutoff))?;
        let mut purged = 0;
        for row in candidates {
            let Some(audio_dir) = &row.audio_dir else {
                continue;
            };
            if let Err(error) = remove_recording_audio(data_dir, audio_dir) {
                eprintln!("[recording] purge de {} impossible : {error}", row.id);
                continue;
            }
            db.with_conn(|conn| store::mark_audio_purged(conn, &row.id, &iso_utc(now)))?;
            purged += 1;
        }
        Ok(purged)
    }
}

/// Supprime `<data_dir>/<relative>` à condition que son chemin canonique soit strictement sous
/// `<data_dir>/library/generated/recordings/`. Un dossier déjà absent n'est pas une erreur.
pub fn remove_recording_audio(data_dir: &Path, relative: &str) -> Result<(), AudioError> {
    let relative_path = Path::new(relative);
    let escapes = relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)));
    if escapes {
        return Err(AudioError::File(
            "dossier audio hors du dossier des enregistrements".to_owned(),
        ));
    }
    let target = data_dir.join(relative_path);
    if !target.exists() {
        return Ok(());
    }
    let base = data_dir
        .join(RECORDINGS_RELATIVE_DIR)
        .canonicalize()
        .map_err(file_error)?;
    let resolved = target.canonicalize().map_err(file_error)?;
    if resolved == base || !resolved.starts_with(&base) {
        return Err(AudioError::File(
            "dossier audio hors du dossier des enregistrements".to_owned(),
        ));
    }
    std::fs::remove_dir_all(resolved).map_err(file_error)
}

fn link_event_entities(
    conn: &rusqlite::Connection,
    note_id: &str,
    event: Option<&Item>,
) -> Result<(), RepoError> {
    let Some(event) = event else {
        return Ok(());
    };
    for entity_id in store::entities_of_item(conn, &event.id)? {
        store::insert_link(
            conn,
            ("item", note_id),
            ("entity", &entity_id),
            store::REL_ABOUT,
            "auto",
        )?;
    }
    Ok(())
}

async fn stop_plans(plans: Vec<SourcePlan>) {
    for mut plan in plans {
        let _ = tokio::task::spawn_blocking(move || plan.backend.stop()).await;
    }
}

struct Session {
    inner: Arc<Inner>,
    row: RecordingRow,
    note_id: String,
    chunk_seconds: u32,
    max_duration: Duration,
    engine: Arc<dyn SttEngine>,
    shared: Arc<Shared>,
    plans: Vec<SourcePlan>,
    stop_rx: oneshot::Receiver<()>,
}

/// Exécute la session et garantit que le signal, l'emplacement actif et la sortie sont toujours libérés.
async fn supervise(session: Session, done_tx: watch::Sender<Option<Recording>>) {
    let inner = session.inner.clone();
    let row = session.row.clone();
    let note_id = session.note_id.clone();
    let outcome = tokio::spawn(run_session(session)).await;
    let recording = match outcome {
        Ok(recording) => recording,
        Err(error) => {
            eprintln!("[recording] session interrompue : {error}");
            inner.indicator.hide();
            fail_recording(&inner, &row, &note_id, "session interrompue")
        }
    };
    *inner.slot() = None;
    inner.publish(&recording);
    let _ = done_tx.send(Some(recording));
}

fn fail_recording(inner: &Inner, row: &RecordingRow, note_id: &str, message: &str) -> Recording {
    let result = inner.db.with_conn(|conn| {
        let segments = store::list_segments(conn, &row.id)?;
        let duration = segments
            .iter()
            .map(|segment| segment.end_ms)
            .max()
            .unwrap_or(0);
        store::finish_recording(
            conn,
            &row.id,
            RecordingStatus::Failed,
            &now_iso_utc(),
            duration,
            Some(message),
        )?;
        let data =
            store::transcript_data(&row.started_at, Some(duration), &row.stt_model, "failed");
        store::update_transcript_note(conn, note_id, &render_transcript(&segments), &data)?;
        store::require_recording(conn, &row.id)
    });
    match result {
        Ok(updated) => updated.to_recording(),
        Err(_) => Recording {
            status: RecordingStatus::Failed,
            error: Some(message.to_owned()),
            ..row.to_recording()
        },
    }
}

struct SourceReport {
    total_samples: u64,
    error: Option<String>,
}

async fn run_session(session: Session) -> Recording {
    let Session {
        inner,
        row,
        note_id,
        chunk_seconds,
        max_duration,
        engine,
        shared,
        plans,
        stop_rx,
    } = session;
    let started = Instant::now();
    let (job_tx, job_rx) = tokio::sync::mpsc::unbounded_channel::<Job>();
    let (halt_tx, halt_rx) = watch::channel(false);
    let mic_peak = Arc::new(AtomicU32::new(0));
    let system_peak = Arc::new(AtomicU32::new(0));
    let has_mic = plans.iter().any(|plan| plan.kind == SegmentSource::Mic);
    let has_system = plans.iter().any(|plan| plan.kind == SegmentSource::System);

    let worker = tokio::spawn(transcription_worker(
        job_rx,
        engine,
        inner.db.clone(),
        shared.clone(),
        row.id.clone(),
        note_id.clone(),
        row.started_at.clone(),
        row.stt_model.clone(),
    ));
    let mut readers: Vec<JoinHandle<SourceReport>> = Vec::new();
    for plan in plans {
        let peak = match plan.kind {
            SegmentSource::Mic => mic_peak.clone(),
            SegmentSource::System => system_peak.clone(),
        };
        readers.push(tokio::spawn(read_source(
            plan,
            chunk_seconds,
            job_tx.clone(),
            shared.clone(),
            peak,
            halt_rx.clone(),
        )));
    }
    drop(job_tx);

    let deadline = started + max_duration;
    let mut stop_rx = stop_rx;
    let mut ticker = tokio::time::interval(LEVEL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut stop_rx => break,
            _ = tokio::time::sleep_until(deadline) => break,
            _ = ticker.tick() => {
                let take = |peak: &AtomicU32, present: bool| {
                    present.then(|| f32::from_bits(peak.swap(0, Ordering::Relaxed)))
                };
                inner.bus.emit(LEVEL_TOPIC, &LevelPayload {
                    recording_id: &row.id,
                    mic: take(&mic_peak, has_mic),
                    system: take(&system_peak, has_system),
                });
            }
        }
    }

    let finalizing = enter_finalizing(&inner, &row.id);
    inner.indicator.hide();
    if let Some(recording) = &finalizing {
        inner.publish(recording);
    }
    let _ = halt_tx.send(true);
    let mut total_samples = 0u64;
    let mut problems: Vec<String> = Vec::new();
    for reader in readers {
        match reader.await {
            Ok(report) => {
                total_samples = total_samples.max(report.total_samples);
                problems.extend(report.error);
            }
            Err(error) => problems.push(format!("lecture audio : {error}")),
        }
    }
    if worker.await.is_err() {
        problems.push("file de transcription interrompue".to_owned());
    }
    let audio_ms = total_samples * 1000 / u64::from(TARGET_SAMPLE_RATE);
    let duration_ms = audio_ms.max(started.elapsed().as_millis() as u64);
    let failed_blocks = shared.failed_blocks.load(Ordering::SeqCst);
    if failed_blocks > 0 {
        problems.push(format!("{failed_blocks} bloc(s) non transcrit(s)"));
    }
    let error = (!problems.is_empty()).then(|| problems.join(" ; "));
    match finalize(&inner, &row, &note_id, duration_ms, error.as_deref()).await {
        Ok(recording) => recording,
        Err(error) => fail_recording(&inner, &row, &note_id, &error.to_string()),
    }
}

fn enter_finalizing(inner: &Inner, id: &str) -> Option<Recording> {
    let _ = inner
        .db
        .with_conn(|conn| store::set_recording_status(conn, id, RecordingStatus::Finalizing));
    let mut slot = inner.slot();
    let active = slot.as_mut()?;
    active.recording.status = RecordingStatus::Finalizing;
    Some(active.recording.clone())
}

async fn finalize(
    inner: &Inner,
    row: &RecordingRow,
    note_id: &str,
    duration_ms: u64,
    error: Option<&str>,
) -> Result<Recording, RecordingError> {
    let ended_at = now_iso_utc();
    let body = inner.db.with_conn(|conn| {
        let segments = store::list_segments(conn, &row.id)?;
        let body = render_transcript(&segments);
        let data =
            store::transcript_data(&row.started_at, Some(duration_ms), &row.stt_model, "done");
        store::update_transcript_note(conn, note_id, &body, &data)?;
        let event = store::event_of_transcript(conn, note_id)?;
        if let Some(event_id) = event {
            for entity_id in store::entities_of_item(conn, &event_id)? {
                store::insert_link(
                    conn,
                    ("item", note_id),
                    ("entity", &entity_id),
                    store::REL_ABOUT,
                    "auto",
                )?;
            }
        }
        Ok(body)
    })?;
    // Sans module actif ni Ollama les chunks sont écrits sans vecteur : la finalisation ne devient pas `failed`.
    let embedder = inner.host.embedder().await;
    index_item_text(&inner.db, embedder.as_ref(), note_id, &body).await?;
    inner
        .db
        .with_conn(|conn| {
            store::finish_recording(
                conn,
                &row.id,
                RecordingStatus::Done,
                &ended_at,
                duration_ms,
                error,
            )?;
            Ok(store::require_recording(conn, &row.id)?.to_recording())
        })
        .map_err(RecordingError::from)
}

struct SourceState {
    buffer: Vec<f32>,
    levels: Vec<f32>,
    emitted_samples: u64,
    total_samples: u64,
    error: Option<String>,
}

struct SourceReader {
    kind: SegmentSource,
    chunk_seconds: u32,
    jobs: UnboundedSender<Job>,
    shared: Arc<Shared>,
    peak: Arc<AtomicU32>,
    writer: Option<Writer>,
    state: SourceState,
}

impl SourceReader {
    fn accept(&mut self, samples: &[f32]) {
        let peak = rms_level(samples);
        self.peak.fetch_max(peak.to_bits(), Ordering::Relaxed);
        self.state.total_samples += samples.len() as u64;
        if self.state.error.is_none() {
            if let Some(writer) = self.writer.as_mut() {
                let written = samples
                    .iter()
                    .try_for_each(|sample| writer.write_sample(sample_to_i16(*sample)));
                if let Err(error) = written {
                    self.state.error = Some(format!("écriture audio : {error}"));
                }
            }
        }
        self.state.buffer.extend_from_slice(samples);
        while (self.state.levels.len() + 1) * WINDOW_SAMPLES <= self.state.buffer.len() {
            let start = self.state.levels.len() * WINDOW_SAMPLES;
            let level = rms_level(&self.state.buffer[start..start + WINDOW_SAMPLES]);
            self.state.levels.push(level);
        }
        while let Some(cut) = pick_cut_point(&self.state.levels, self.chunk_seconds) {
            self.emit(cut * WINDOW_SAMPLES, cut);
            self.flush_writer();
        }
    }

    /// Émet les `samples` premiers échantillons (dont `windows` fenêtres complètes) comme un bloc.
    fn emit(&mut self, samples: usize, windows: usize) {
        let block: Vec<f32> = self.state.buffer.drain(..samples).collect();
        let mut levels: Vec<f32> = self.state.levels.drain(..windows).collect();
        let offset_ms = self.state.emitted_samples * 1000 / u64::from(TARGET_SAMPLE_RATE);
        self.state.emitted_samples += samples as u64;
        if samples > windows * WINDOW_SAMPLES {
            levels.push(rms_level(&block[windows * WINDOW_SAMPLES..]));
        }
        if block.len() < MIN_BLOCK_SAMPLES || is_silent(&levels) {
            return;
        }
        self.shared.enqueue();
        let job = Job {
            source: self.kind,
            offset_ms,
            samples: block,
        };
        if self.jobs.send(job).is_err() {
            self.shared.complete();
        }
    }

    fn flush_rest(&mut self) {
        let samples = self.state.buffer.len();
        if samples > 0 {
            let windows = self.state.levels.len();
            self.emit(samples, windows);
        }
    }

    fn flush_writer(&mut self) {
        if let Some(writer) = self.writer.as_mut() {
            if let Err(error) = writer.flush() {
                self.state
                    .error
                    .get_or_insert(format!("écriture audio : {error}"));
            }
        }
    }

    fn finish(mut self) -> SourceReport {
        self.flush_rest();
        if let Some(writer) = self.writer.take() {
            if let Err(error) = writer.finalize() {
                self.state
                    .error
                    .get_or_insert(format!("écriture audio : {error}"));
            }
        }
        SourceReport {
            total_samples: self.state.total_samples,
            error: self.state.error,
        }
    }
}

async fn read_source(
    plan: SourcePlan,
    chunk_seconds: u32,
    jobs: UnboundedSender<Job>,
    shared: Arc<Shared>,
    peak: Arc<AtomicU32>,
    mut halt: watch::Receiver<bool>,
) -> SourceReport {
    let SourcePlan {
        kind,
        mut backend,
        mut rx,
        writer,
    } = plan;
    let mut reader = SourceReader {
        kind,
        chunk_seconds,
        jobs,
        shared,
        peak,
        writer: Some(writer),
        state: SourceState {
            buffer: Vec::new(),
            levels: Vec::new(),
            emitted_samples: 0,
            total_samples: 0,
            error: None,
        },
    };
    let mut closed = false;
    loop {
        tokio::select! {
            _ = halt.changed() => break,
            frame = rx.recv(), if !closed => match frame {
                Some(frame) => reader.accept(&frame.samples),
                None => closed = true,
            },
        }
    }
    // L'arrêt du flux peut bloquer tant que le canal est plein : on continue à le vider.
    let mut stopper = tokio::task::spawn_blocking(move || backend.stop());
    loop {
        tokio::select! {
            _ = &mut stopper => break,
            frame = rx.recv(), if !closed => match frame {
                Some(frame) => reader.accept(&frame.samples),
                None => closed = true,
            },
        }
    }
    while let Ok(frame) = rx.try_recv() {
        reader.accept(&frame.samples);
    }
    reader.finish()
}

#[allow(clippy::too_many_arguments)]
async fn transcription_worker(
    mut jobs: UnboundedReceiver<Job>,
    engine: Arc<dyn SttEngine>,
    db: Arc<Db>,
    shared: Arc<Shared>,
    recording_id: String,
    note_id: String,
    started_at: String,
    stt_model: String,
) {
    while let Some(job) = jobs.recv().await {
        let options = TranscribeOptions {
            language: LANGUAGE.to_owned(),
            initial_prompt: None,
        };
        match transcribe_blocking(engine.clone(), job.samples, options).await {
            Ok(found) => {
                let segments: Vec<TranscriptSegment> = found
                    .into_iter()
                    .filter(|segment| !segment.text.trim().is_empty())
                    .map(|segment| TranscriptSegment {
                        source: job.source,
                        start_ms: job.offset_ms + segment.start_ms,
                        end_ms: job.offset_ms + segment.end_ms,
                        text: segment.text.trim().to_owned(),
                    })
                    .collect();
                let stored = db.with_conn(|conn| {
                    for segment in &segments {
                        store::append_segment(conn, &recording_id, segment)?;
                    }
                    let all = store::list_segments(conn, &recording_id)?;
                    let data = store::transcript_data(&started_at, None, &stt_model, "live");
                    store::update_transcript_note(conn, &note_id, &render_transcript(&all), &data)
                });
                match stored {
                    Ok(()) => {
                        for segment in &segments {
                            shared.bus.emit(
                                SEGMENT_TOPIC,
                                &SegmentPayload {
                                    recording_id: &recording_id,
                                    segment,
                                },
                            );
                        }
                    }
                    Err(error) => {
                        shared.failed_blocks.fetch_add(1, Ordering::SeqCst);
                        eprintln!("[recording] segments non enregistrés : {error}");
                    }
                }
            }
            Err(error) => {
                shared.failed_blocks.fetch_add(1, Ordering::SeqCst);
                eprintln!("[recording] bloc non transcrit : {error}");
            }
        }
        shared.complete();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::capture::WavFileBackend;
    use crate::stt::{FakeSttEngine, SttSegment, DEMO_TRANSCRIPT};
    use regis_core::db::repo::recordings as store;
    use regis_core::db::repo::testing::{sample_connector, test_db};
    use regis_core::db::repo::{
        insert_links_if_absent, save_entity, upsert, upsert_items, EntitySave,
    };
    use regis_core::events::{EventSink, RegisEvent};
    use regis_core::files::embed::testing::unreachable_embedder;
    use regis_model::{EntityKind, ItemUpsert, LinkProposalRow, RecordingSources};
    use std::sync::atomic::AtomicUsize;

    const CHUNK_SECONDS: u32 = 2;

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

    struct TestHost {
        wav: PathBuf,
        calls: Arc<AtomicUsize>,
        loopback: bool,
        ready: bool,
    }

    impl RecordingHost for TestHost {
        fn config(&self) -> RecordingConfig {
            RecordingConfig {
                chunk_seconds: CHUNK_SECONDS,
                max_duration: Duration::from_secs(600),
                mic_device_id: None,
                system_device_id: None,
            }
        }
        fn new_backend(&self, _source: AudioSource) -> Box<dyn CaptureBackend> {
            Box::new(WavFileBackend::new(self.wav.clone()))
        }
        fn engine(&self) -> EngineFuture {
            let engine: Arc<dyn SttEngine> = Arc::new(CountingEngine {
                calls: self.calls.clone(),
                inner: FakeSttEngine::demo(),
            });
            Box::pin(async move { Ok(engine) })
        }
        fn model_ready(&self) -> ReadyFuture {
            let ready = self.ready;
            Box::pin(async move { ready })
        }
        fn model_id(&self) -> String {
            "fake-model".to_owned()
        }
        fn loopback_supported(&self) -> bool {
            self.loopback
        }
        fn embedder(&self) -> EmbedderFuture {
            Box::pin(async { Some(unreachable_embedder()) })
        }
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<RegisEvent>>);

    impl EventSink for Recorder {
        fn publish(&self, event: RegisEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    #[derive(Default)]
    struct CountingIndicator {
        shown: AtomicUsize,
        hidden: AtomicUsize,
    }

    impl RecordingIndicator for CountingIndicator {
        fn show(&self, _recording: &Recording) {
            self.shown.fetch_add(1, Ordering::SeqCst);
        }
        fn hide(&self) {
            self.hidden.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Harness {
        manager: RecordingManager,
        db: Arc<Db>,
        data_dir: PathBuf,
        calls: Arc<AtomicUsize>,
        events: Arc<Recorder>,
        indicator: Arc<CountingIndicator>,
    }

    fn write_wav(path: &Path, amplitude: f32, seconds: u32) {
        let mut writer = hound::WavWriter::create(path, wav_spec()).unwrap();
        for index in 0..(TARGET_SAMPLE_RATE * seconds) {
            let phase =
                2.0 * std::f32::consts::PI * 220.0 * index as f32 / TARGET_SAMPLE_RATE as f32;
            writer
                .write_sample(sample_to_i16(amplitude * phase.sin()))
                .unwrap();
        }
        writer.finalize().unwrap();
    }

    fn harness(name: &str, amplitude: f32, loopback: bool) -> Harness {
        let data_dir =
            std::env::temp_dir().join(format!("regis-rec-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        let wav = data_dir.join("source.wav");
        write_wav(&wav, amplitude, 6);
        let db = Arc::new(test_db(&format!("rec-{name}")));
        let calls = Arc::new(AtomicUsize::new(0));
        let events = Arc::new(Recorder::default());
        let indicator = Arc::new(CountingIndicator::default());
        let host = Arc::new(TestHost {
            wav,
            calls: calls.clone(),
            loopback,
            ready: true,
        });
        let manager = RecordingManager::new(
            db.clone(),
            data_dir.clone(),
            EventBus::new(events.clone()),
            host,
            indicator.clone(),
        );
        Harness {
            manager,
            db,
            data_dir,
            calls,
            events,
            indicator,
        }
    }

    fn input(sources: RecordingSources) -> StartRecordingInput {
        StartRecordingInput {
            title: Some("Point client".to_owned()),
            sources,
            event_item_id: None,
            entity_id: None,
            consent_confirmed: true,
            consent_text: "J'ai informé tous les participants.".to_owned(),
        }
    }

    async fn wait_for(condition: impl Fn() -> bool) {
        for _ in 0..200 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("condition non atteinte");
    }

    fn segment_count(harness: &Harness, id: &str) -> usize {
        harness
            .db
            .with_conn(|conn| store::list_segments(conn, id))
            .map(|segments| segments.len())
            .unwrap_or(0)
    }

    #[tokio::test]
    async fn start_without_consent_creates_nothing_and_a_second_start_is_refused() {
        let h = harness("consent", 0.3, true);
        let mut refused = input(RecordingSources::Mic);
        refused.consent_confirmed = false;
        assert!(matches!(
            h.manager.start(refused).await,
            Err(RecordingError::ConsentRequired)
        ));
        let rows: i64 =
            h.db.with_conn(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM recordings", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(rows, 0);
        assert!(!h.data_dir.join(RECORDINGS_RELATIVE_DIR).exists());

        let started = h.manager.start(input(RecordingSources::Mic)).await.unwrap();
        assert!(matches!(
            h.manager.start(input(RecordingSources::Mic)).await,
            Err(RecordingError::AlreadyRecording)
        ));
        assert_eq!(h.manager.active().map(|r| r.id), Some(started.id.clone()));
        h.manager.stop(&started.id).await.unwrap();
        assert!(h.manager.active().is_none());
    }

    #[tokio::test]
    async fn system_audio_is_refused_where_loopback_is_unsupported() {
        let h = harness("loopback", 0.3, false);
        for sources in [RecordingSources::System, RecordingSources::Both] {
            assert!(matches!(
                h.manager.start(input(sources)).await,
                Err(RecordingError::UnsupportedSource(_))
            ));
        }
        assert!(h.manager.start(input(RecordingSources::Mic)).await.is_ok());
        let id = h.manager.active().unwrap().id;
        h.manager.stop(&id).await.unwrap();
    }

    fn seed_event_with_entity(h: &Harness) -> (String, String) {
        h.db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            let entity = save_entity(
                conn,
                EntitySave {
                    id: None,
                    kind: EntityKind::Client,
                    name: "Atelier Rhône".to_owned(),
                    tags_json: serde_json::json!([]),
                    data_json: serde_json::json!({}),
                },
            )?;
            upsert_items(
                conn,
                &[ItemUpsert {
                    connector_id: "c1".to_owned(),
                    kind: ItemKind::Event,
                    external_id: "ev-1".to_owned(),
                    title: "Point projet".to_owned(),
                    body_text: None,
                    occurred_at: Some("2026-10-22T08:00:00.000Z".to_owned()),
                    data_json: serde_json::json!({}),
                    updated_at: "2026-10-22T08:00:00.000Z".to_owned(),
                }],
            )?;
            let event: Item = repo::list_where(conn, "kind = 'event'", "rowid", Vec::new())?
                .into_iter()
                .next()
                .unwrap();
            insert_links_if_absent(
                conn,
                &[LinkProposalRow {
                    from_type: "item".to_owned(),
                    from_id: event.id.clone(),
                    to_entity_id: entity.id.clone(),
                    rel: "about".to_owned(),
                    confidence: None,
                }],
                "auto",
            )?;
            Ok((event.id, entity.id))
        })
        .unwrap()
    }

    fn links_of(h: &Harness) -> Vec<(String, String, String, String, String, String)> {
        h.db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT from_type, from_id, to_type, to_id, rel, origin FROM links ORDER BY rowid",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap()
    }

    #[tokio::test]
    async fn a_both_session_linked_to_an_event_creates_row_note_links_and_wav_files() {
        let h = harness("both", 0.3, true);
        let (event_id, entity_id) = seed_event_with_entity(&h);
        let mut start = input(RecordingSources::Both);
        start.event_item_id = Some(event_id.clone());
        let recording = h.manager.start(start).await.unwrap();
        assert_eq!(recording.status, RecordingStatus::Recording);
        assert_eq!(h.indicator.shown.load(Ordering::SeqCst), 1);

        let view = h.manager.view(&recording.id).unwrap();
        let note_id = view.transcript_item_id.clone();
        assert_eq!(view.event_item_id.as_deref(), Some(event_id.as_str()));
        let note: Item =
            h.db.with_conn(|conn| repo::require::<Item>(conn, &note_id))
                .unwrap();
        assert_eq!(note.data_json["noteType"], "transcript");
        assert_eq!(note.data_json["status"], "live");
        assert!(note.data_json.get("eventId").is_none());
        let row =
            h.db.with_conn(|conn| store::require_recording(conn, &recording.id))
                .unwrap();
        assert!(!row.consent_at.is_empty() && !row.consent_text.is_empty());
        assert_eq!(
            row.audio_dir.as_deref(),
            Some(format!("{RECORDINGS_RELATIVE_DIR}/{}", recording.id).as_str())
        );

        let links = links_of(&h);
        let has = |from: (&str, &str), to: (&str, &str), rel: &str, origin: &str| {
            links.iter().any(|link| {
                (
                    link.0.as_str(),
                    link.1.as_str(),
                    link.2.as_str(),
                    link.3.as_str(),
                ) == (from.0, from.1, to.0, to.1)
                    && link.4 == rel
                    && link.5 == origin
            })
        };
        assert!(has(
            ("recording", &recording.id),
            ("item", &note_id),
            "produced",
            "auto"
        ));
        assert!(has(
            ("item", &note_id),
            ("item", &event_id),
            "about",
            "auto"
        ));
        assert!(has(
            ("item", &note_id),
            ("entity", &entity_id),
            "about",
            "auto"
        ));

        h.manager.stop(&recording.id).await.unwrap();
        let audio = h.data_dir.join(RECORDINGS_RELATIVE_DIR).join(&recording.id);
        assert!(audio.join("mic.wav").is_file());
        assert!(audio.join("system.wav").is_file());
        let reader = hound::WavReader::open(audio.join("mic.wav")).unwrap();
        assert_eq!(reader.spec().sample_rate, TARGET_SAMPLE_RATE);
    }

    #[tokio::test]
    async fn stopping_finalizes_the_note_indexes_it_and_offsets_the_blocks() {
        let h = harness("final", 0.3, true);
        let recording = h.manager.start(input(RecordingSources::Mic)).await.unwrap();
        wait_for(|| segment_count(&h, &recording.id) >= 2).await;
        let stopped = h.manager.stop(&recording.id).await.unwrap();
        assert_eq!(stopped.status, RecordingStatus::Done);
        assert!(stopped.duration_ms.is_some());

        let (segments, note) =
            h.db.with_conn(|conn| {
                let note_id = store::transcript_item_id(conn, &recording.id)?.unwrap();
                Ok((
                    store::list_segments(conn, &recording.id)?,
                    repo::require::<Item>(conn, &note_id)?,
                ))
            })
            .unwrap();
        assert_eq!(
            note.body_text.as_deref(),
            Some(render_transcript(&segments).as_str())
        );
        assert_eq!(note.data_json["status"], "done");
        assert!(note.body_text.unwrap().contains(DEMO_TRANSCRIPT));
        let chunks: i64 =
            h.db.with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM chunks WHERE owner_type = 'item' AND owner_id = ?1",
                    [&note.id],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert!(chunks > 0);

        assert!(segments
            .windows(2)
            .all(|pair| pair[0].start_ms < pair[1].start_ms));
        assert!(segments.len() >= 2);
        assert!(segments[1].start_ms >= u64::from(CHUNK_SECONDS) * 1_000 / 2);
        assert_eq!(h.indicator.hidden.load(Ordering::SeqCst), 1);
        let topics: Vec<String> = h
            .events
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.topic.clone())
            .collect();
        for topic in [STATE_TOPIC, SEGMENT_TOPIC, LEVEL_TOPIC, BACKLOG_TOPIC] {
            assert!(topics.iter().any(|known| known == topic), "{topic}");
        }
    }

    #[tokio::test]
    async fn a_word_only_present_in_a_transcript_is_found_in_the_notes_group() {
        let h = harness("search", 0.3, true);
        let recording = h.manager.start(input(RecordingSources::Mic)).await.unwrap();
        wait_for(|| segment_count(&h, &recording.id) >= 1).await;
        h.manager.stop(&recording.id).await.unwrap();
        let hits =
            regis_core::search::search_with_vector(&h.db, "démonstration", None, 10).unwrap();
        let result =
            h.db.with_conn(|conn| repo::group_search(conn, "démonstration", &hits))
                .unwrap();
        assert_eq!(result.notes.len(), 1);
        assert_eq!(result.notes[0].note_type, "transcript");
        assert!(result.mails.is_empty());
    }

    #[tokio::test]
    async fn a_silent_block_never_reaches_the_engine() {
        let h = harness("silent", 0.0, true);
        let recording = h.manager.start(input(RecordingSources::Mic)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let stopped = h.manager.stop(&recording.id).await.unwrap();
        assert_eq!(stopped.status, RecordingStatus::Done);
        assert_eq!(h.calls.load(Ordering::SeqCst), 0);
        assert_eq!(segment_count(&h, &recording.id), 0);
    }

    #[tokio::test]
    async fn a_free_recording_links_the_chosen_entity_as_a_user_link() {
        let h = harness("free", 0.3, true);
        let (_, entity_id) = seed_event_with_entity(&h);
        let mut start = input(RecordingSources::Mic);
        start.entity_id = Some(entity_id.clone());
        let recording = h.manager.start(start).await.unwrap();
        h.manager.stop(&recording.id).await.unwrap();
        let links = links_of(&h);
        assert!(links
            .iter()
            .any(|link| link.2 == "entity" && link.3 == entity_id && link.5 == "user"));

        let h2 = harness("free-bare", 0.3, true);
        let bare = h2
            .manager
            .start(input(RecordingSources::Mic))
            .await
            .unwrap();
        h2.manager.stop(&bare.id).await.unwrap();
        assert!(links_of(&h2).iter().all(|link| link.2 != "entity"));
    }

    #[test]
    fn recover_interrupted_fails_the_session_and_renders_its_segments() {
        let db = test_db("rec-recover");
        let row = RecordingRow {
            id: "r1".to_owned(),
            title: "Point".to_owned(),
            status: RecordingStatus::Recording,
            sources: RecordingSources::Mic,
            started_at: "2026-10-22T08:00:00.000Z".to_owned(),
            ended_at: None,
            duration_ms: None,
            consent_at: "2026-10-22T08:00:00.000Z".to_owned(),
            consent_text: "ok".to_owned(),
            stt_model: "fake".to_owned(),
            audio_dir: Some(format!("{RECORDINGS_RELATIVE_DIR}/r1")),
            audio_purged_at: None,
            error: None,
        };
        let note_id = db
            .with_conn(|conn| {
                store::insert_recording(conn, &row)?;
                let note = store::create_transcript_note(conn, &row)?;
                store::insert_link(
                    conn,
                    ("recording", "r1"),
                    ("item", &note.id),
                    "produced",
                    "auto",
                )?;
                store::append_segment(
                    conn,
                    "r1",
                    &TranscriptSegment {
                        source: SegmentSource::Mic,
                        start_ms: 0,
                        end_ms: 1_000,
                        text: "Bonjour".to_owned(),
                    },
                )?;
                Ok(note.id)
            })
            .unwrap();
        assert_eq!(RecordingManager::recover_interrupted(&db).unwrap(), 1);
        db.with_conn(|conn| {
            let recovered = store::require_recording(conn, "r1")?;
            assert_eq!(recovered.status, RecordingStatus::Failed);
            assert!(recovered.error.is_some_and(|error| !error.is_empty()));
            let note = repo::require::<Item>(conn, &note_id)?;
            assert_eq!(
                note.body_text.as_deref(),
                Some("**[00:00:00] Moi** : Bonjour")
            );
            assert_eq!(note.data_json["status"], "failed");
            Ok(())
        })
        .unwrap();
        assert_eq!(RecordingManager::recover_interrupted(&db).unwrap(), 0);
    }

    fn finished(id: &str, ended_at: &str) -> RecordingRow {
        RecordingRow {
            id: id.to_owned(),
            title: id.to_owned(),
            status: RecordingStatus::Done,
            sources: RecordingSources::Mic,
            started_at: ended_at.to_owned(),
            ended_at: Some(ended_at.to_owned()),
            duration_ms: Some(1_000),
            consent_at: ended_at.to_owned(),
            consent_text: "ok".to_owned(),
            stt_model: "fake".to_owned(),
            audio_dir: Some(format!("{RECORDINGS_RELATIVE_DIR}/{id}")),
            audio_purged_at: None,
            error: None,
        }
    }

    #[test]
    fn purge_deletes_only_expired_audio_inside_the_recordings_folder() {
        let db = test_db("rec-purge");
        let data_dir = std::env::temp_dir().join(format!("regis-purge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let days_ago = |days: u64| iso_utc(now - Duration::from_secs(days * SECONDS_PER_DAY));
        let outside = data_dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), "x").unwrap();
        let mut escaping = finished("escape", &days_ago(40));
        escaping.audio_dir = Some("../outside".to_owned());
        for row in [
            finished("old", &days_ago(31)),
            finished("recent", &days_ago(29)),
            escaping,
        ] {
            if let Some(dir) = &row.audio_dir {
                let _ = std::fs::create_dir_all(data_dir.join(dir));
            }
            db.with_conn(|conn| store::insert_recording(conn, &row))
                .unwrap();
        }
        std::fs::create_dir_all(data_dir.join(RECORDINGS_RELATIVE_DIR).join("old")).unwrap();
        std::fs::write(
            data_dir.join(RECORDINGS_RELATIVE_DIR).join("old/mic.wav"),
            "x",
        )
        .unwrap();

        let purged = RecordingManager::purge_expired_audio(&db, &data_dir, 30, now).unwrap();
        assert_eq!(purged, 1);
        assert!(!data_dir.join(RECORDINGS_RELATIVE_DIR).join("old").exists());
        assert!(data_dir
            .join(RECORDINGS_RELATIVE_DIR)
            .join("recent")
            .exists());
        assert!(outside.join("keep.txt").exists());
        db.with_conn(|conn| {
            assert!(store::require_recording(conn, "old")?
                .audio_purged_at
                .is_some());
            assert!(store::require_recording(conn, "recent")?
                .audio_purged_at
                .is_none());
            assert!(
                !store::require_recording(conn, "old")?
                    .to_recording()
                    .audio_available
            );
            Ok(())
        })
        .unwrap();
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn audio_removal_refuses_absolute_and_parent_paths() {
        let data_dir = std::env::temp_dir().join(format!("regis-purge-abs-{}", std::process::id()));
        std::fs::create_dir_all(data_dir.join(RECORDINGS_RELATIVE_DIR)).unwrap();
        assert!(remove_recording_audio(&data_dir, "..").is_err());
        assert!(remove_recording_audio(&data_dir, RECORDINGS_RELATIVE_DIR).is_err());
        assert!(remove_recording_audio(&data_dir, "library/../library").is_err());
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
