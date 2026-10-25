use std::fs::File;
use std::io::Read;
use std::path::Path;

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use super::chunk::{chunk_text, DEFAULT_OVERLAP, DEFAULT_TARGET};
use super::embed::{
    vector_to_blob, EmbedError, OllamaEmbedder, DEFAULT_EMBEDDING_MODEL, DEFAULT_OLLAMA_URL,
};
use super::extract::extract_text;
use super::sources::{self, FileSourceInfo, STATE_IDLE, STATE_INDEXING, STATE_WAITING_OLLAMA};
use crate::db::repo::{self, RepoError};
use crate::db::Db;
use crate::events::now_iso_utc;
use crate::modules::{is_enabled, LocalModuleId};
use regis_model::{FileEntry, FileSource};

pub const SETTING_OLLAMA_URL: &str = "ollama.url";
pub const SETTING_EMBEDDING_MODEL: &str = "embeddings.model";
pub const SETTING_MAX_FILE_MB: &str = "files.maxFileMb";
pub const DEFAULT_MAX_FILE_MB: u64 = 50;

#[derive(Debug, Default)]
pub struct IndexOutcome {
    pub indexed: usize,
    pub skipped: usize,
    pub errors: usize,
    pub halted: Option<String>,
    pub backfill_remaining: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum IndexFailure {
    #[error(transparent)]
    Embed(#[from] EmbedError),
    #[error(transparent)]
    Repo(#[from] RepoError),
}

enum FileResult {
    Indexed,
    Skipped,
    Failed,
}

enum Content {
    NotIndexable,
    Failed(String),
    Chunks(Vec<String>),
}

struct Prepared {
    sha256: String,
    content: Content,
}

pub fn load_embedder(db: &Db) -> OllamaEmbedder {
    let setting = |key: &str, default: &str| {
        db.with_conn(|conn| repo::get_setting(conn, key))
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| default.to_owned())
    };
    OllamaEmbedder {
        url: setting(SETTING_OLLAMA_URL, DEFAULT_OLLAMA_URL),
        model: setting(SETTING_EMBEDDING_MODEL, DEFAULT_EMBEDDING_MODEL),
    }
}

pub fn load_max_file_bytes(db: &Db) -> u64 {
    let megabytes = db
        .with_conn(|conn| repo::get_setting(conn, SETTING_MAX_FILE_MB))
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_MAX_FILE_MB);
    megabytes.saturating_mul(1024 * 1024)
}

pub fn has_pending(db: &Db, semantic: bool) -> bool {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM files f JOIN file_sources s ON s.id = f.source_id
              WHERE f.status = 'pending' AND s.state != 'offline')
                OR (?1 AND EXISTS (SELECT 1 FROM chunks
                  WHERE id NOT IN (SELECT rowid FROM chunks_vec)))",
            [semantic],
            |row| row.get::<_, bool>(0),
        )?)
    })
    .unwrap_or(false)
}

/// `embedder` vaut `None` tant que la recherche sémantique n'est pas active : les chunks sont
/// écrits sans vecteur et Ollama n'est pas appelé. Le rattrapage des vecteurs avance d'un seul
/// lot par appel, après la file des fichiers : l'appelant relance tant que `backfill_remaining`.
pub async fn index_pending(
    db: &Db,
    embedder: Option<&OllamaEmbedder>,
    on_progress: &(dyn Fn(&FileSourceInfo) + Sync),
    on_backfill: &(dyn Fn(usize, usize) + Sync),
) -> IndexOutcome {
    let mut outcome = index_queue(db, embedder, on_progress).await;
    if let (Some(embedder), None) = (embedder, &outcome.halted) {
        match backfill_vectors(db, embedder, on_backfill).await {
            Ok(remaining) => outcome.backfill_remaining = remaining > 0,
            Err(error) => outcome.halted = Some(error.to_string()),
        }
    }
    outcome
}

async fn index_queue(
    db: &Db,
    embedder: Option<&OllamaEmbedder>,
    on_progress: &(dyn Fn(&FileSourceInfo) + Sync),
) -> IndexOutcome {
    let mut outcome = IndexOutcome::default();
    let queue = match pending_queue(db) {
        Ok(queue) => queue,
        Err(error) => {
            outcome.halted = Some(error.to_string());
            return outcome;
        }
    };
    if queue.is_empty() {
        return outcome;
    }
    let mut source_ids: Vec<String> = Vec::new();
    for (source, _) in &queue {
        if !source_ids.contains(&source.id) {
            source_ids.push(source.id.clone());
        }
    }
    for source_id in &source_ids {
        change_state(db, source_id, STATE_INDEXING, on_progress);
    }
    for (source, file) in &queue {
        match index_file(db, embedder, source, file).await {
            Ok(FileResult::Indexed) => outcome.indexed += 1,
            Ok(FileResult::Skipped) => outcome.skipped += 1,
            Ok(FileResult::Failed) => outcome.errors += 1,
            Err(IndexFailure::Embed(error)) => {
                outcome.halted = Some(error.to_string());
                break;
            }
            Err(IndexFailure::Repo(error)) => {
                eprintln!("[indexer] {}: {error}", file.rel_path);
                outcome.errors += 1;
            }
        }
        emit_info(db, &source.id, on_progress);
    }
    for source_id in &source_ids {
        let waiting = outcome.halted.is_some() && source_has_pending(db, source_id);
        let state = if waiting {
            STATE_WAITING_OLLAMA
        } else {
            STATE_IDLE
        };
        change_state(db, source_id, state, on_progress);
    }
    outcome
}

const BACKFILL_BATCH: i64 = 64;

/// Vectorise un lot borné de chunks (fichiers et items) sans vecteur et renvoie combien en
/// restent. Ne fait rien dès que le module est désactivé.
pub async fn backfill_vectors(
    db: &Db,
    embedder: &OllamaEmbedder,
    on_progress: &(dyn Fn(usize, usize) + Sync),
) -> Result<usize, IndexFailure> {
    if !is_enabled(db, LocalModuleId::Embeddings) {
        return Ok(0);
    }
    let batch: Vec<(i64, String)> = db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, text FROM chunks
              WHERE id NOT IN (SELECT rowid FROM chunks_vec) ORDER BY id LIMIT ?1",
        )?;
        let rows = statement.query_map([BACKFILL_BATCH], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    if !batch.is_empty() {
        let texts: Vec<String> = batch.iter().map(|(_, text)| text.clone()).collect();
        let vectors = embedder.embed(&texts).await?;
        db.with_conn(|conn| {
            let transaction = conn.transaction()?;
            for ((id, _), vector) in batch.iter().zip(&vectors) {
                transaction.execute(
                    "INSERT INTO chunks_vec (rowid, embedding) VALUES (?1, ?2)",
                    params![id, vector_to_blob(vector)],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })?;
    }
    let (total, remaining): (usize, usize) = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE id NOT IN (SELECT rowid FROM chunks_vec))
               FROM chunks",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? as usize,
                    row.get::<_, i64>(1)? as usize,
                ))
            },
        )?)
    })?;
    if !batch.is_empty() {
        on_progress(total - remaining, total);
    }
    Ok(remaining)
}

fn pending_queue(db: &Db) -> Result<Vec<(FileSource, FileEntry)>, RepoError> {
    db.with_conn(|conn| {
        let files: Vec<FileEntry> = repo::list_where(
            conn,
            "status = 'pending' AND source_id IN (SELECT id FROM file_sources WHERE state != 'offline')",
            "source_id, rowid",
            Vec::new(),
        )?;
        let mut queue = Vec::with_capacity(files.len());
        let mut sources: Vec<FileSource> = Vec::new();
        for file in files {
            if !sources.iter().any(|source| source.id == file.source_id) {
                sources.push(repo::require(conn, &file.source_id)?);
            }
            if let Some(source) = sources.iter().find(|source| source.id == file.source_id) {
                queue.push((source.clone(), file));
            }
        }
        Ok(queue)
    })
}

fn source_has_pending(db: &Db, source_id: &str) -> bool {
    sources::list_sources(db)
        .map(|list| {
            list.iter()
                .any(|info| info.id == source_id && info.pending_count > 0)
        })
        .unwrap_or(false)
}

fn change_state(db: &Db, source_id: &str, state: &str, on_progress: &dyn Fn(&FileSourceInfo)) {
    if sources::set_state(db, source_id, state, None).is_ok() {
        emit_info(db, source_id, on_progress);
    }
}

fn emit_info(db: &Db, source_id: &str, on_progress: &dyn Fn(&FileSourceInfo)) {
    if let Ok(info) = db.with_conn(|conn| sources::source_info(conn, source_id)) {
        on_progress(&info);
    }
}

async fn index_file(
    db: &Db,
    embedder: Option<&OllamaEmbedder>,
    source: &FileSource,
    file: &FileEntry,
) -> Result<FileResult, IndexFailure> {
    let path = Path::new(&source.path).join(&file.rel_path);
    let prepared = tokio::task::spawn_blocking(move || prepare(&path))
        .await
        .map_err(|error| RepoError::Invalid(error.to_string()))?;
    let Some(Prepared { sha256, content }) = prepared else {
        return Ok(FileResult::Skipped);
    };
    let unchanged = file.indexed_at.is_some() && file.sha256.as_deref() == Some(sha256.as_str());
    if unchanged && !matches!(content, Content::Failed(_)) {
        db.with_conn(|conn| {
            finish_file(
                conn,
                &file.id,
                "indexed",
                Some(&sha256),
                file.indexed_at.as_deref(),
            )
        })?;
        return Ok(FileResult::Indexed);
    }
    match content {
        Content::NotIndexable => {
            replace_chunks(db, &file.id, &[], None, "skipped", &sha256, None)?;
            Ok(FileResult::Skipped)
        }
        Content::Failed(message) => {
            eprintln!("[indexer] {}: {message}", file.rel_path);
            replace_chunks(db, &file.id, &[], None, "error", &sha256, None)?;
            Ok(FileResult::Failed)
        }
        Content::Chunks(chunks) if chunks.is_empty() => {
            let now = now_iso_utc();
            replace_chunks(db, &file.id, &[], None, "indexed", &sha256, Some(&now))?;
            Ok(FileResult::Indexed)
        }
        Content::Chunks(chunks) => {
            let Some(embedder) = embedder else {
                let now = now_iso_utc();
                replace_chunks(db, &file.id, &chunks, None, "indexed", &sha256, Some(&now))?;
                return Ok(FileResult::Indexed);
            };
            match embedder.embed(&chunks).await {
                Ok(vectors) => {
                    let now = now_iso_utc();
                    replace_chunks(
                        db,
                        &file.id,
                        &chunks,
                        Some(&vectors),
                        "indexed",
                        &sha256,
                        Some(&now),
                    )?;
                    Ok(FileResult::Indexed)
                }
                Err(error) => {
                    replace_chunks(db, &file.id, &chunks, None, "pending", &sha256, None)?;
                    Err(IndexFailure::Embed(error))
                }
            }
        }
    }
}

fn prepare(path: &Path) -> Option<Prepared> {
    let sha256 = sha256_file(path).ok()?;
    let content = match extract_text(path) {
        Ok(None) => Content::NotIndexable,
        Ok(Some(text)) => Content::Chunks(chunk_text(&text, DEFAULT_TARGET, DEFAULT_OVERLAP)),
        Err(error) => Content::Failed(error.to_string()),
    };
    Some(Prepared { sha256, content })
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn finish_file(
    conn: &Connection,
    file_id: &str,
    status: &str,
    sha256: Option<&str>,
    indexed_at: Option<&str>,
) -> Result<(), RepoError> {
    conn.execute(
        "UPDATE files SET status = ?2, sha256 = ?3, indexed_at = ?4 WHERE id = ?1",
        params![file_id, status, sha256, indexed_at],
    )?;
    Ok(())
}

fn replace_chunks(
    db: &Db,
    file_id: &str,
    chunks: &[String],
    vectors: Option<&[Vec<f32>]>,
    status: &str,
    sha256: &str,
    indexed_at: Option<&str>,
) -> Result<(), RepoError> {
    db.with_conn(|conn| {
        let transaction = conn.transaction()?;
        delete_file_chunks(&transaction, file_id)?;
        for (ordinal, text) in chunks.iter().enumerate() {
            transaction.execute(
                "INSERT INTO chunks (owner_type, owner_id, ord, text) VALUES ('file', ?1, ?2, ?3)",
                params![file_id, ordinal as i64, text],
            )?;
            if let Some(vector) = vectors.and_then(|all| all.get(ordinal)) {
                transaction.execute(
                    "INSERT INTO chunks_vec (rowid, embedding) VALUES (?1, ?2)",
                    params![transaction.last_insert_rowid(), vector_to_blob(vector)],
                )?;
            }
        }
        finish_file(&transaction, file_id, status, Some(sha256), indexed_at)?;
        transaction.commit()?;
        Ok(())
    })
}

/// Indexe le texte d'un item (transcript) : découpage, embeddings si le module est actif et
/// qu'Ollama répond, sinon chunks seuls (FTS). Un échec d'embedding n'est pas une erreur : les
/// vecteurs manquants restent absents jusqu'au rattrapage.
pub async fn index_item_text(
    db: &Db,
    embedder: Option<&OllamaEmbedder>,
    item_id: &str,
    body: &str,
) -> Result<usize, RepoError> {
    let chunks = chunk_text(body, DEFAULT_TARGET, DEFAULT_OVERLAP);
    let vectors = match embedder {
        Some(embedder) if !chunks.is_empty() => embedder.embed(&chunks).await.ok(),
        _ => None,
    };
    db.with_conn(|conn| replace_item_chunks(conn, item_id, &chunks, vectors.as_deref()))?;
    Ok(chunks.len())
}

/// Remplace les chunks `owner_type = 'item'` d'un item, dans une transaction.
pub fn replace_item_chunks(
    conn: &mut Connection,
    item_id: &str,
    chunks: &[String],
    vectors: Option<&[Vec<f32>]>,
) -> Result<(), RepoError> {
    let transaction = conn.transaction()?;
    transaction.execute(
        "DELETE FROM chunks WHERE owner_type = 'item' AND owner_id = ?1",
        [item_id],
    )?;
    for (ordinal, text) in chunks.iter().enumerate() {
        transaction.execute(
            "INSERT INTO chunks (owner_type, owner_id, ord, text) VALUES ('item', ?1, ?2, ?3)",
            params![item_id, ordinal as i64, text],
        )?;
        if let Some(vector) = vectors.and_then(|all| all.get(ordinal)) {
            transaction.execute(
                "INSERT INTO chunks_vec (rowid, embedding) VALUES (?1, ?2)",
                params![transaction.last_insert_rowid(), vector_to_blob(vector)],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

pub fn delete_file_chunks(conn: &Connection, file_id: &str) -> Result<(), RepoError> {
    conn.execute(
        "DELETE FROM chunks WHERE owner_type = 'file' AND owner_id = ?1",
        [file_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    use super::*;
    use crate::db::repo::testing::test_db;
    use crate::files::embed::testing::{unreachable_embedder, MockOllama};
    use crate::files::sources::add_source;
    use crate::files::watcher::scan_source;

    struct Fixture {
        db: Db,
        dir: PathBuf,
        source_id: String,
    }

    fn fixture(name: &str) -> Fixture {
        let dir =
            std::env::temp_dir().join(format!("regis-indexer-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let db = test_db(&format!("indexer-{name}"));
        let source =
            add_source(&db, "local", &dir.to_string_lossy(), None, None, true).expect("source");
        Fixture {
            db,
            dir,
            source_id: source.id,
        }
    }

    fn count(db: &Db, table: &str) -> i64 {
        db.with_conn(|conn| {
            Ok(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("count")
    }

    fn fts_hits(db: &Db, term: &str) -> i64 {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH ?1",
                [term],
                |row| row.get(0),
            )?)
        })
        .expect("fts")
    }

    fn file_status(db: &Db) -> String {
        db.with_conn(|conn| Ok(conn.query_row("SELECT status FROM files", [], |row| row.get(0))?))
            .expect("status")
    }

    #[tokio::test]
    async fn item_chunks_written_without_ollama_get_their_vectors_later() {
        let fixture = fixture("item-vectors");
        crate::modules::set_enabled(&fixture.db, LocalModuleId::Embeddings, true).expect("enable");
        let chunks = vec!["compte rendu du point client".to_owned()];
        fixture
            .db
            .with_conn(|conn| replace_item_chunks(conn, "note-1", &chunks, None))
            .expect("chunks");
        assert_eq!(count(&fixture.db, "chunks_vec"), 0);
        assert!(has_pending(&fixture.db, true));

        let outcome = index_pending(
            &fixture.db,
            Some(&unreachable_embedder()),
            &|_| {},
            &|_, _| {},
        )
        .await;
        assert!(outcome.halted.is_some());
        assert_eq!(count(&fixture.db, "chunks_vec"), 0);

        let mock = MockOllama::start();
        let outcome = index_pending(&fixture.db, Some(&mock.embedder()), &|_| {}, &|_, _| {}).await;
        assert!(outcome.halted.is_none());
        assert_eq!(count(&fixture.db, "chunks_vec"), 1);
        assert!(!has_pending(&fixture.db, true));
    }

    #[tokio::test]
    async fn unchanged_files_are_embedded_once_and_changes_replace_old_chunks() {
        let fixture = fixture("incremental");
        let mock = MockOllama::start();
        let embedder = mock.embedder();
        let path = fixture.dir.join("notes.md");
        std::fs::write(&path, "alpha zebra notes").expect("write");

        for _ in 0..2 {
            scan_source(&fixture.db, &fixture.source_id, u64::MAX).expect("scan");
            index_pending(&fixture.db, Some(&embedder), &|_| {}, &|_, _| {}).await;
        }
        assert_eq!(mock.request_count(), 1);
        assert_eq!(count(&fixture.db, "chunks"), 1);
        assert_eq!(count(&fixture.db, "chunks_vec"), 1);
        assert_eq!(fts_hits(&fixture.db, "zebra"), 1);

        std::fs::write(&path, "beta quokka notes with a longer body").expect("rewrite");
        scan_source(&fixture.db, &fixture.source_id, u64::MAX).expect("scan");
        index_pending(&fixture.db, Some(&embedder), &|_| {}, &|_, _| {}).await;
        assert_eq!(mock.request_count(), 2);
        assert_eq!(count(&fixture.db, "chunks"), 1);
        assert_eq!(count(&fixture.db, "chunks_vec"), 1);
        assert_eq!(fts_hits(&fixture.db, "zebra"), 0);
        assert_eq!(fts_hits(&fixture.db, "quokka"), 1);
    }

    #[tokio::test]
    async fn touched_file_with_same_content_is_not_embedded_again() {
        let fixture = fixture("touch");
        let mock = MockOllama::start();
        let embedder = mock.embedder();
        let path = fixture.dir.join("notes.md");
        std::fs::write(&path, "stable content").expect("write");
        scan_source(&fixture.db, &fixture.source_id, u64::MAX).expect("scan");
        index_pending(&fixture.db, Some(&embedder), &|_| {}, &|_, _| {}).await;

        let handle = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open");
        handle
            .set_modified(SystemTime::now() + Duration::from_secs(3600))
            .expect("touch");
        drop(handle);
        let report = scan_source(&fixture.db, &fixture.source_id, u64::MAX).expect("scan");
        assert_eq!(report.changed, 1);
        assert!(has_pending(&fixture.db, true));
        index_pending(&fixture.db, Some(&embedder), &|_| {}, &|_, _| {}).await;

        assert_eq!(mock.request_count(), 1);
        assert_eq!(file_status(&fixture.db), "indexed");
    }

    #[tokio::test]
    async fn files_stay_pending_while_ollama_is_down_and_resume_later() {
        let fixture = fixture("resume");
        std::fs::write(fixture.dir.join("notes.md"), "marmot burrow").expect("write");
        scan_source(&fixture.db, &fixture.source_id, u64::MAX).expect("scan");

        let outcome = index_pending(
            &fixture.db,
            Some(&unreachable_embedder()),
            &|_| {},
            &|_, _| {},
        )
        .await;
        assert!(outcome.halted.is_some());
        assert_eq!(file_status(&fixture.db), "pending");
        assert_eq!(fts_hits(&fixture.db, "marmot"), 1);
        assert_eq!(count(&fixture.db, "chunks_vec"), 0);
        let state = sources::list_sources(&fixture.db).expect("list")[0]
            .state
            .clone();
        assert_eq!(state, STATE_WAITING_OLLAMA);

        let mock = MockOllama::start();
        let outcome = index_pending(&fixture.db, Some(&mock.embedder()), &|_| {}, &|_, _| {}).await;
        assert_eq!(outcome.indexed, 1);
        assert_eq!(file_status(&fixture.db), "indexed");
        assert_eq!(count(&fixture.db, "chunks"), 1);
        assert_eq!(count(&fixture.db, "chunks_vec"), 1);
    }

    #[tokio::test]
    async fn unreadable_documents_are_marked_as_errors_and_unknown_types_skipped() {
        let fixture = fixture("errors");
        std::fs::write(fixture.dir.join("broken.pdf"), b"%PDF-garbage").expect("write");
        std::fs::write(fixture.dir.join("plan.dwg"), b"binary").expect("write");
        scan_source(&fixture.db, &fixture.source_id, u64::MAX).expect("scan");
        let mock = MockOllama::start();
        let outcome = index_pending(&fixture.db, Some(&mock.embedder()), &|_| {}, &|_, _| {}).await;
        assert_eq!(outcome.errors, 1);
        let statuses: Vec<(String, String)> = fixture
            .db
            .with_conn(|conn| {
                let mut statement =
                    conn.prepare("SELECT rel_path, status FROM files ORDER BY rel_path")?;
                let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
                Ok(rows.collect::<rusqlite::Result<_>>()?)
            })
            .expect("statuses");
        assert_eq!(
            statuses,
            [
                ("broken.pdf".to_owned(), "error".to_owned()),
                ("plan.dwg".to_owned(), "skipped".to_owned())
            ]
        );
        assert_eq!(mock.request_count(), 0);
    }

    #[tokio::test]
    async fn without_an_embedder_files_are_indexed_as_text_only() {
        let fixture = fixture("text-only");
        let mock = MockOllama::start();
        std::fs::write(fixture.dir.join("notes.md"), "narwhal tusk").expect("write");
        scan_source(&fixture.db, &fixture.source_id, u64::MAX).expect("scan");

        let outcome = index_pending(&fixture.db, None, &|_| {}, &|_, _| {}).await;
        assert_eq!(outcome.indexed, 1);
        assert!(outcome.halted.is_none());
        assert_eq!(file_status(&fixture.db), "indexed");
        assert_eq!(count(&fixture.db, "chunks"), 1);
        assert_eq!(count(&fixture.db, "chunks_vec"), 0);
        assert_eq!(fts_hits(&fixture.db, "narwhal"), 1);
        assert_eq!(mock.request_count(), 0);
        assert!(!has_pending(&fixture.db, false));
    }

    #[tokio::test]
    async fn activation_backfills_every_chunk_without_a_vector() {
        let fixture = fixture("backfill");
        let mock = MockOllama::start();
        std::fs::write(fixture.dir.join("a.md"), "alpaca wool").expect("write");
        std::fs::write(fixture.dir.join("b.md"), "bison herd").expect("write");
        scan_source(&fixture.db, &fixture.source_id, u64::MAX).expect("scan");
        index_pending(&fixture.db, None, &|_| {}, &|_, _| {}).await;
        fixture
            .db
            .with_conn(|conn| {
                replace_item_chunks(conn, "note-1", &["transcript text".to_owned()], None)
            })
            .expect("item chunks");
        assert_eq!(count(&fixture.db, "chunks"), 3);
        assert_eq!(count(&fixture.db, "chunks_vec"), 0);
        assert!(has_pending(&fixture.db, true));

        crate::modules::set_enabled(&fixture.db, LocalModuleId::Embeddings, true).expect("enable");
        let progress = std::sync::Mutex::new(Vec::new());
        let outcome = index_pending(
            &fixture.db,
            Some(&mock.embedder()),
            &|_| {},
            &|done, total| {
                progress.lock().expect("lock").push((done, total));
            },
        )
        .await;
        assert!(outcome.halted.is_none());
        assert_eq!(count(&fixture.db, "chunks_vec"), 3);
        assert_eq!(
            progress.into_inner().expect("progress").last(),
            Some(&(3, 3))
        );
        assert!(!has_pending(&fixture.db, true));
    }

    #[tokio::test]
    async fn backfill_stops_when_the_module_is_disabled() {
        let fixture = fixture("backfill-stop");
        let mock = MockOllama::start();
        fixture
            .db
            .with_conn(|conn| {
                replace_item_chunks(conn, "note-1", &["transcript text".to_owned()], None)
            })
            .expect("item chunks");
        let remaining = backfill_vectors(&fixture.db, &mock.embedder(), &|_, _| {})
            .await
            .expect("backfill");
        assert_eq!(remaining, 0);
        assert_eq!(count(&fixture.db, "chunks_vec"), 0);
        assert_eq!(mock.request_count(), 0);
    }

    #[tokio::test]
    async fn a_long_backfill_advances_one_batch_at_a_time_and_does_not_delay_new_files() {
        let fixture = fixture("backfill-batches");
        let mock = MockOllama::start();
        let chunks: Vec<String> = (0..BACKFILL_BATCH + 6)
            .map(|index| format!("transcript part {index}"))
            .collect();
        fixture
            .db
            .with_conn(|conn| replace_item_chunks(conn, "note-1", &chunks, None))
            .expect("item chunks");
        crate::modules::set_enabled(&fixture.db, LocalModuleId::Embeddings, true).expect("enable");
        std::fs::write(fixture.dir.join("late.md"), "pangolin scales").expect("write");
        scan_source(&fixture.db, &fixture.source_id, u64::MAX).expect("scan");

        let first = index_pending(&fixture.db, Some(&mock.embedder()), &|_| {}, &|_, _| {}).await;

        assert_eq!(first.indexed, 1);
        assert_eq!(file_status(&fixture.db), "indexed");
        assert!(first.backfill_remaining);
        assert_eq!(
            count(&fixture.db, "chunks_vec"),
            BACKFILL_BATCH + 1,
            "one file chunk and one bounded batch of item chunks"
        );

        let second = index_pending(&fixture.db, Some(&mock.embedder()), &|_| {}, &|_, _| {}).await;
        assert!(!second.backfill_remaining);
        assert_eq!(
            count(&fixture.db, "chunks_vec"),
            count(&fixture.db, "chunks")
        );
    }
}
