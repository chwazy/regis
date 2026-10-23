use std::collections::{HashMap, HashSet};
use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::types::Value;
use rusqlite::Connection;
use tokio::sync::mpsc;

use super::extract::is_indexable_extension;
use super::indexer::{delete_file_chunks, has_pending, index_pending, load_max_file_bytes};
use super::sources::{
    self, role_for_source, FileSourceInfo, STATE_IDLE, STATE_OFFLINE, STATE_SCANNING,
};
use crate::db::repo::{self, RepoError};
use crate::db::Db;
use crate::events::{iso_utc, now_iso_utc, EventBus};
use crate::modules::embeddings::active_embedder;
use crate::modules::BACKFILL_PROGRESS_TOPIC;
use regis_model::{FileEntry, FileSource};

const TICK: Duration = Duration::from_secs(1);
const EVENT_DEBOUNCE: Duration = Duration::from_secs(2);
const REALTIME_SAFETY_RESCAN: Duration = Duration::from_secs(60 * 60);
const PENDING_RETRY: Duration = Duration::from_secs(60);
const PROGRESS_TOPIC: &str = "index.progress";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
    pub unchanged: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("source is offline: {0}")]
    Offline(String),
    #[error(transparent)]
    Repo(#[from] RepoError),
}

pub enum Registration {
    Added,
    Changed,
    Unchanged,
}

struct DiscoveredFile {
    rel_path: String,
    metadata: Metadata,
}

pub fn register_file(
    conn: &Connection,
    source: &FileSource,
    rel_path: &str,
    metadata: &Metadata,
    max_bytes: u64,
) -> Result<(FileEntry, Registration), RepoError> {
    let extension = Path::new(rel_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let size = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
    let mtime = metadata.modified().map(iso_utc).unwrap_or_default();
    let existing: Vec<FileEntry> = repo::list_where(
        conn,
        "source_id = ?1 AND rel_path = ?2",
        "rowid",
        vec![
            Value::Text(source.id.clone()),
            Value::Text(rel_path.to_owned()),
        ],
    )?;
    let existing = existing.into_iter().next();
    if let Some(entry) = &existing {
        if entry.size == size && entry.mtime == mtime {
            return Ok((entry.clone(), Registration::Unchanged));
        }
    }
    let listable_only = !is_indexable_extension(&extension) || metadata.len() > max_bytes;
    let status = if listable_only { "skipped" } else { "pending" };
    let entry = FileEntry {
        id: existing
            .as_ref()
            .map_or_else(repo::new_id, |entry| entry.id.clone()),
        source_id: source.id.clone(),
        rel_path: rel_path.to_owned(),
        ext: extension,
        size,
        mtime,
        sha256: existing.as_ref().and_then(|entry| entry.sha256.clone()),
        role: role_for_source(source).to_owned(),
        status: status.to_owned(),
        indexed_at: existing.as_ref().and_then(|entry| entry.indexed_at.clone()),
    };
    repo::upsert(conn, &entry)?;
    if listable_only {
        delete_file_chunks(conn, &entry.id)?;
    }
    let registration = if existing.is_some() {
        Registration::Changed
    } else {
        Registration::Added
    };
    Ok((entry, registration))
}

fn walk(root: &Path) -> (Vec<DiscoveredFile>, bool) {
    let mut files = Vec::new();
    let mut complete = true;
    let mut pending: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            complete = false;
            continue;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                complete = false;
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                complete = false;
                continue;
            };
            if file_type.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file() || entry.file_name().to_string_lossy().starts_with("~$") {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                complete = false;
                continue;
            };
            let Ok(relative) = entry.path().strip_prefix(root).map(Path::to_path_buf) else {
                continue;
            };
            let rel_path = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            files.push(DiscoveredFile { rel_path, metadata });
        }
    }
    (files, complete)
}

pub fn scan_source(db: &Db, source_id: &str, max_bytes: u64) -> Result<ScanReport, ScanError> {
    let source: FileSource = db.with_conn(|conn| repo::require(conn, source_id))?;
    let root = Path::new(&source.path);
    match std::fs::metadata(root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(ScanError::Offline(format!(
                "{} is not a folder",
                source.path
            )))
        }
        Err(error) => return Err(ScanError::Offline(error.to_string())),
    }
    let (discovered, complete) = walk(root);
    let report = db.with_conn(|conn| {
        let transaction = conn.transaction()?;
        let mut report = ScanReport::default();
        let mut seen: HashSet<&str> = HashSet::new();
        for file in &discovered {
            seen.insert(file.rel_path.as_str());
            let (_, registration) = register_file(
                &transaction,
                &source,
                &file.rel_path,
                &file.metadata,
                max_bytes,
            )?;
            match registration {
                Registration::Added => report.added += 1,
                Registration::Changed => report.changed += 1,
                Registration::Unchanged => report.unchanged += 1,
            }
        }
        if complete {
            let known: Vec<FileEntry> = repo::list_where(
                &transaction,
                "source_id = ?1",
                "rowid",
                vec![Value::Text(source.id.clone())],
            )?;
            for entry in known
                .iter()
                .filter(|entry| !seen.contains(entry.rel_path.as_str()))
            {
                delete_file_chunks(&transaction, &entry.id)?;
                repo::delete::<FileEntry>(&transaction, &entry.id)?;
                report.removed += 1;
            }
        }
        transaction.commit()?;
        Ok(report)
    })?;
    Ok(report)
}

pub fn sync_source(
    db: &Db,
    source_id: &str,
    max_bytes: u64,
    on_progress: &dyn Fn(&FileSourceInfo),
) -> Result<ScanReport, ScanError> {
    let publish = |db: &Db| {
        if let Ok(info) = db.with_conn(|conn| sources::source_info(conn, source_id)) {
            on_progress(&info);
        }
    };
    sources::set_state(db, source_id, STATE_SCANNING, None)?;
    publish(db);
    let result = scan_source(db, source_id, max_bytes);
    match &result {
        Ok(_) => sources::set_state(db, source_id, STATE_IDLE, Some(&now_iso_utc()))?,
        Err(ScanError::Offline(_)) => sources::set_state(db, source_id, STATE_OFFLINE, None)?,
        Err(ScanError::Repo(_)) => sources::set_state(db, source_id, STATE_IDLE, None)?,
    }
    publish(db);
    result
}

enum Command {
    Reload,
    Rescan(String),
    Changed(String),
    IndexNow,
}

#[derive(Clone)]
pub struct WatcherHandle {
    commands: mpsc::UnboundedSender<Command>,
}

impl WatcherHandle {
    pub fn reload(&self) {
        let _ = self.commands.send(Command::Reload);
    }

    pub fn rescan(&self, source_id: &str) {
        let _ = self.commands.send(Command::Rescan(source_id.to_owned()));
    }

    pub fn index_now(&self) {
        let _ = self.commands.send(Command::IndexNow);
    }
}

pub fn spawn(db: Arc<Db>, bus: EventBus) -> WatcherHandle {
    let (commands, receiver) = mpsc::unbounded_channel();
    let handle = WatcherHandle {
        commands: commands.clone(),
    };
    tokio::spawn(run(db, bus, commands, receiver));
    handle.reload();
    handle
}

struct Schedule {
    watchers: HashMap<String, RecommendedWatcher>,
    next_poll: HashMap<String, Instant>,
    dirty: HashMap<String, Instant>,
    forced: HashSet<String>,
}

async fn run(
    db: Arc<Db>,
    bus: EventBus,
    commands: mpsc::UnboundedSender<Command>,
    mut receiver: mpsc::UnboundedReceiver<Command>,
) {
    let mut schedule = Schedule {
        watchers: HashMap::new(),
        next_poll: HashMap::new(),
        dirty: HashMap::new(),
        forced: HashSet::new(),
    };
    let mut index_requested = false;
    let mut backfill_remaining = false;
    let mut last_index_attempt = Instant::now();
    let mut ticker = tokio::time::interval(TICK);
    let backfill_bus = bus.clone();
    let publish = move |info: &FileSourceInfo| bus.emit(PROGRESS_TOPIC, info);
    let publish_backfill = move |done: usize, total: usize| {
        backfill_bus.emit(
            BACKFILL_PROGRESS_TOPIC,
            &serde_json::json!({ "done": done, "total": total }),
        )
    };
    loop {
        tokio::select! {
            command = receiver.recv() => match command {
                None => break,
                Some(Command::Reload) => reload_sources(&db, &commands, &mut schedule),
                Some(Command::Rescan(id)) => { schedule.forced.insert(id); }
                Some(Command::Changed(id)) => { schedule.dirty.entry(id).or_insert_with(Instant::now); }
                Some(Command::IndexNow) => index_requested = true,
            },
            _ = ticker.tick() => {}
            _ = tokio::task::yield_now(), if backfill_remaining => {}
        }
        let due = due_sources(&mut schedule, &db);
        let mut scanned_any = false;
        for source_id in due {
            scanned_any = true;
            let worker_db = db.clone();
            let max_bytes = load_max_file_bytes(&db);
            let id = source_id.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let collected = std::sync::Mutex::new(Vec::new());
                let result = sync_source(&worker_db, &id, max_bytes, &|info| {
                    if let Ok(mut list) = collected.lock() {
                        list.push(info.clone());
                    }
                });
                (result, collected.into_inner().unwrap_or_default())
            })
            .await;
            if let Ok((result, infos)) = outcome {
                infos.iter().for_each(&publish);
                if let Err(ScanError::Repo(error)) = result {
                    eprintln!("[watcher] scan of {source_id} failed: {error}");
                }
            }
        }
        let embedder = active_embedder(&db).await;
        let retry_due =
            last_index_attempt.elapsed() >= PENDING_RETRY && has_pending(&db, embedder.is_some());
        if scanned_any || index_requested || retry_due || backfill_remaining {
            index_requested = false;
            last_index_attempt = Instant::now();
            let outcome = index_pending(&db, embedder.as_ref(), &publish, &publish_backfill).await;
            backfill_remaining = outcome.backfill_remaining;
        }
    }
}

fn reload_sources(db: &Db, commands: &mpsc::UnboundedSender<Command>, schedule: &mut Schedule) {
    let Ok(sources) = sources::list_sources(db) else {
        return;
    };
    let known: HashSet<&str> = sources.iter().map(|info| info.id.as_str()).collect();
    schedule
        .watchers
        .retain(|id, _| known.contains(id.as_str()));
    schedule
        .next_poll
        .retain(|id, _| known.contains(id.as_str()));
    for info in &sources {
        if schedule.next_poll.contains_key(&info.id) {
            continue;
        }
        schedule.forced.insert(info.id.clone());
        let interval = match info.watch_mode.as_str() {
            "poll" => Duration::from_secs(60 * info.poll_minutes.unwrap_or(10).max(1) as u64),
            _ => REALTIME_SAFETY_RESCAN,
        };
        schedule
            .next_poll
            .insert(info.id.clone(), Instant::now() + interval);
        if let Some(watcher) = start_notifications(&info.id, &info.path, commands) {
            schedule.watchers.insert(info.id.clone(), watcher);
        }
    }
}

fn start_notifications(
    source_id: &str,
    path: &str,
    commands: &mpsc::UnboundedSender<Command>,
) -> Option<RecommendedWatcher> {
    let sender = commands.clone();
    let id = source_id.to_owned();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if !matches!(event.kind, EventKind::Access(_)) {
                let _ = sender.send(Command::Changed(id.clone()));
            }
        }
    })
    .ok()?;
    watcher
        .watch(Path::new(path), RecursiveMode::Recursive)
        .ok()?;
    Some(watcher)
}

fn due_sources(schedule: &mut Schedule, db: &Db) -> Vec<String> {
    let now = Instant::now();
    let mut due: Vec<String> = schedule.forced.drain().collect();
    let settled: Vec<String> = schedule
        .dirty
        .iter()
        .filter(|(_, since)| now.duration_since(**since) >= EVENT_DEBOUNCE)
        .map(|(id, _)| id.clone())
        .collect();
    for id in settled {
        schedule.dirty.remove(&id);
        due.push(id);
    }
    let polled: Vec<String> = schedule
        .next_poll
        .iter()
        .filter(|(_, at)| **at <= now)
        .map(|(id, _)| id.clone())
        .collect();
    for id in polled {
        let interval = sources::list_sources(db)
            .ok()
            .and_then(|list| list.into_iter().find(|info| info.id == id))
            .map(|info| match info.watch_mode.as_str() {
                "poll" => Duration::from_secs(60 * info.poll_minutes.unwrap_or(10).max(1) as u64),
                _ => REALTIME_SAFETY_RESCAN,
            })
            .unwrap_or(REALTIME_SAFETY_RESCAN);
        schedule.next_poll.insert(id.clone(), now + interval);
        due.push(id);
    }
    let mut seen = HashSet::new();
    due.retain(|id| seen.insert(id.clone()));
    due
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::db::repo::testing::test_db;
    use crate::events::EventSink;
    use crate::files::embed::testing::MockOllama;
    use crate::files::sources::add_source;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("regis-watcher-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn unreachable_network_share_goes_offline_and_keeps_its_files() {
        let db = test_db("offline-share");
        let source = add_source(&db, "smb", r"\\nas-missing\plans", None, None).expect("add");
        db.with_conn(|conn| {
            repo::upsert(
                conn,
                &FileEntry {
                    id: "f1".to_owned(),
                    source_id: source.id.clone(),
                    rel_path: "old/plan.pdf".to_owned(),
                    ext: "pdf".to_owned(),
                    size: 10,
                    mtime: "2026-01-01T00:00:00.000Z".to_owned(),
                    sha256: Some("abc".to_owned()),
                    role: "reference".to_owned(),
                    status: "indexed".to_owned(),
                    indexed_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
                },
            )?;
            conn.execute(
                "INSERT INTO chunks (owner_type, owner_id, ord, text) VALUES ('file', 'f1', 0, 'plan text')",
                [],
            )?;
            Ok(())
        })
        .expect("seed");

        let result = sync_source(&db, &source.id, u64::MAX, &|_| {});
        assert!(matches!(result, Err(ScanError::Offline(_))));

        let infos = sources::list_sources(&db).expect("list");
        assert_eq!(infos[0].state, STATE_OFFLINE);
        assert_eq!(infos[0].file_count, 1);
        let files = sources::list_files(&db, None, None, false).expect("files");
        assert_eq!(files.len(), 1);
        let chunks: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?)
            })
            .expect("chunks");
        assert_eq!(chunks, 1);
    }

    #[test]
    fn scan_reports_additions_changes_and_removals() {
        let dir = temp_dir("scan-report");
        let db = test_db("scan-report");
        let source = add_source(&db, "local", &dir.to_string_lossy(), None, None).expect("add");
        std::fs::create_dir_all(dir.join("sub")).expect("subdir");
        std::fs::write(dir.join("a.md"), "aaa").expect("write");
        std::fs::write(dir.join("sub").join("b.txt"), "bbb").expect("write");
        std::fs::write(dir.join("plan.dwg"), "dwg").expect("write");
        std::fs::write(dir.join("huge.md"), "x".repeat(2048)).expect("write");

        let first = scan_source(&db, &source.id, 1024).expect("scan");
        assert_eq!(first.added, 4);
        let files = sources::list_files(&db, None, None, false).expect("files");
        let status_of = |name: &str| {
            files
                .iter()
                .find(|file| file.rel_path == name)
                .map(|file| file.status.clone())
                .unwrap_or_default()
        };
        assert_eq!(status_of("a.md"), "pending");
        assert_eq!(status_of("sub/b.txt"), "pending");
        assert_eq!(status_of("plan.dwg"), "skipped");
        assert_eq!(status_of("huge.md"), "skipped");

        std::fs::write(dir.join("a.md"), "aaa changed").expect("rewrite");
        std::fs::remove_file(dir.join("sub").join("b.txt")).expect("remove");
        let second = scan_source(&db, &source.id, 1024).expect("scan");
        assert_eq!(
            second,
            ScanReport {
                added: 0,
                changed: 1,
                removed: 1,
                unchanged: 2
            }
        );
    }

    struct CollectingSink(Mutex<Vec<String>>);

    impl EventSink for CollectingSink {
        fn publish(&self, event: crate::events::RegisEvent) {
            if let Ok(mut topics) = self.0.lock() {
                topics.push(event.topic);
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn watcher_indexes_new_sources_and_reports_progress() {
        let dir = temp_dir("runtime");
        std::fs::write(dir.join("notes.md"), "capybara habitat").expect("write");
        let db = Arc::new(test_db("runtime"));
        let mock = MockOllama::start();
        db.with_conn(|conn| repo::set_setting(conn, "ollama.url", &mock.url))
            .expect("setting");
        let sink = Arc::new(CollectingSink(Mutex::new(Vec::new())));
        let handle = spawn(db.clone(), EventBus::new(sink.clone()));
        add_source(&db, "local", &dir.to_string_lossy(), None, None).expect("add");
        handle.reload();

        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let indexed = sources::list_sources(&db)
                .expect("list")
                .iter()
                .map(|info| info.indexed_count)
                .sum::<i64>();
            if indexed == 1 {
                break;
            }
            assert!(Instant::now() < deadline, "file was not indexed in time");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let topics = sink.0.lock().expect("topics").clone();
        assert!(topics.iter().any(|topic| topic == PROGRESS_TOPIC));
        assert_eq!(mock.request_count(), 0);
    }
}
