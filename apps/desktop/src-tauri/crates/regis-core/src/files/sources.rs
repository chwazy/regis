use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use rusqlite::{params, Connection};
use serde::Serialize;
use ts_rs::TS;

use super::indexer::load_max_file_bytes;
use super::watcher::register_file;
use crate::db::repo::{self, RepoError};
use crate::db::Db;
use crate::events::now_iso_utc;
use regis_model::{FileEntry, FileSource};

pub const STATE_UNKNOWN: &str = "unknown";
pub const STATE_IDLE: &str = "idle";
pub const STATE_SCANNING: &str = "scanning";
pub const STATE_INDEXING: &str = "indexing";
pub const STATE_WAITING_OLLAMA: &str = "waiting_ollama";
pub const STATE_OFFLINE: &str = "offline";

pub const DEFAULT_POLL_MINUTES: i64 = 10;

const LIBRARY_DIR: &str = "library";
const MODELS_DIR: &str = "models";
const IMPORTED_DIR: &str = "imported";
const GENERATED_DIR: &str = "generated";
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error(transparent)]
    Repo(#[from] RepoError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
}

impl From<rusqlite::Error> for SourceError {
    fn from(error: rusqlite::Error) -> Self {
        SourceError::Repo(RepoError::Sqlite(error))
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FileSourceInfo {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub watch_mode: String,
    #[ts(type = "number | null")]
    pub poll_minutes: Option<i64>,
    pub state: String,
    pub last_scan_at: Option<String>,
    pub indexed: bool,
    #[ts(type = "number")]
    pub file_count: i64,
    #[ts(type = "number")]
    pub indexed_count: i64,
    #[ts(type = "number")]
    pub pending_count: i64,
    #[ts(type = "number")]
    pub unclassified_count: i64,
}

const SOURCE_INFO_SQL: &str = "SELECT s.id, s.kind, s.path, s.watch_mode, s.poll_minutes, s.state, s.last_scan_at, s.indexed,
        (SELECT COUNT(*) FROM files f WHERE f.source_id = s.id),
        (SELECT COUNT(*) FROM files f WHERE f.source_id = s.id AND f.status = 'indexed'),
        (SELECT COUNT(*) FROM files f WHERE f.source_id = s.id AND f.status = 'pending'),
        (SELECT COUNT(*) FROM files f WHERE f.source_id = s.id AND f.role = 'imported' AND NOT EXISTS (
            SELECT 1 FROM links l WHERE l.from_type = 'file' AND l.from_id = f.id AND l.to_type = 'entity'))
    FROM file_sources s";

fn info_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileSourceInfo> {
    Ok(FileSourceInfo {
        id: row.get(0)?,
        kind: row.get(1)?,
        path: row.get(2)?,
        watch_mode: row.get(3)?,
        poll_minutes: row.get(4)?,
        state: row.get(5)?,
        last_scan_at: row.get(6)?,
        indexed: row.get(7)?,
        file_count: row.get(8)?,
        indexed_count: row.get(9)?,
        pending_count: row.get(10)?,
        unclassified_count: row.get(11)?,
    })
}

pub fn library_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(LIBRARY_DIR)
}

pub fn imported_dir(data_dir: &Path) -> PathBuf {
    library_dir(data_dir).join(IMPORTED_DIR)
}

pub fn models_dir(data_dir: &Path) -> PathBuf {
    library_dir(data_dir).join(MODELS_DIR)
}

pub fn generated_dir(data_dir: &Path) -> PathBuf {
    library_dir(data_dir).join(GENERATED_DIR)
}

pub fn role_for_source(source: &FileSource) -> &'static str {
    if source.kind != "regis" {
        return "reference";
    }
    match Path::new(&source.path)
        .file_name()
        .and_then(|name| name.to_str())
    {
        Some(IMPORTED_DIR) => "imported",
        Some(MODELS_DIR) => "template",
        Some(GENERATED_DIR) => "generated",
        _ => "reference",
    }
}

pub fn ensure_regis_sources(db: &Db, data_dir: &Path) -> Result<(), SourceError> {
    for folder in [MODELS_DIR, IMPORTED_DIR, GENERATED_DIR] {
        let path = library_dir(data_dir).join(folder);
        std::fs::create_dir_all(&path)?;
        let path_text = path.to_string_lossy().into_owned();
        db.with_conn(|conn| {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM file_sources WHERE path = ?1",
                [&path_text],
                |row| row.get(0),
            )?;
            if exists == 0 {
                repo::upsert(
                    conn,
                    &FileSource {
                        id: repo::new_id(),
                        kind: "regis".to_owned(),
                        path: path_text.clone(),
                        watch_mode: "realtime".to_owned(),
                        poll_minutes: None,
                        state: STATE_UNKNOWN.to_owned(),
                        last_scan_at: None,
                        connector_id: None,
                        indexed: true,
                    },
                )?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

pub fn list_sources(db: &Db) -> Result<Vec<FileSourceInfo>, SourceError> {
    Ok(db.with_conn(|conn| {
        let mut statement = conn.prepare(&format!("{SOURCE_INFO_SQL} ORDER BY s.rowid"))?;
        let rows = statement.query_map([], info_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?)
}

pub fn source_info(conn: &Connection, source_id: &str) -> Result<FileSourceInfo, RepoError> {
    conn.query_row(
        &format!("{SOURCE_INFO_SQL} WHERE s.id = ?1"),
        [source_id],
        info_from_row,
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => {
            RepoError::NotFound(format!("file source {source_id}"))
        }
        other => RepoError::Sqlite(other),
    })
}

pub fn get_source(db: &Db, source_id: &str) -> Result<FileSource, SourceError> {
    Ok(db.with_conn(|conn| repo::require(conn, source_id))?)
}

pub fn add_source(
    db: &Db,
    kind: &str,
    path: &str,
    watch_mode: Option<&str>,
    poll_minutes: Option<i64>,
    indexed: bool,
) -> Result<FileSource, SourceError> {
    let path = path.trim();
    if path.is_empty() {
        return Err(SourceError::Invalid("the folder path is empty".to_owned()));
    }
    let (watch_mode, poll_minutes) = match kind {
        "local" => {
            if !Path::new(path).is_dir() {
                return Err(SourceError::Invalid(format!("{path} is not a folder")));
            }
            (watch_mode.unwrap_or("realtime"), poll_minutes)
        }
        "smb" => (
            watch_mode.unwrap_or("poll"),
            Some(poll_minutes.unwrap_or(DEFAULT_POLL_MINUTES)),
        ),
        "cloud" => {
            return Err(SourceError::Invalid(
                "cloud sources are not available yet".to_owned(),
            ))
        }
        other => {
            return Err(SourceError::Invalid(format!(
                "unsupported source kind {other}"
            )))
        }
    };
    if !matches!(watch_mode, "realtime" | "poll") {
        return Err(SourceError::Invalid(format!(
            "unsupported watch mode {watch_mode}"
        )));
    }
    if poll_minutes.is_some_and(|minutes| minutes < 1) {
        return Err(SourceError::Invalid(
            "the scan interval must be at least one minute".to_owned(),
        ));
    }
    let source = FileSource {
        id: repo::new_id(),
        kind: kind.to_owned(),
        path: path.to_owned(),
        watch_mode: watch_mode.to_owned(),
        poll_minutes,
        state: STATE_UNKNOWN.to_owned(),
        last_scan_at: None,
        connector_id: None,
        indexed,
    };
    db.with_conn(|conn| {
        let duplicates: i64 = conn.query_row(
            "SELECT COUNT(*) FROM file_sources WHERE path = ?1",
            [&source.path],
            |row| row.get(0),
        )?;
        if duplicates > 0 {
            return Err(RepoError::Invalid(format!("{path} is already a source")));
        }
        repo::upsert(conn, &source)
    })?;
    Ok(source)
}

pub fn remove_source(db: &Db, source_id: &str) -> Result<(), SourceError> {
    let source = get_source(db, source_id)?;
    if source.kind == "regis" {
        return Err(SourceError::Invalid(
            "Régis library sources cannot be removed".to_owned(),
        ));
    }
    db.with_conn(|conn| {
        let transaction = conn.transaction()?;
        transaction.execute(
            "DELETE FROM chunks WHERE owner_type = 'file'
               AND owner_id IN (SELECT id FROM files WHERE source_id = ?1)",
            [source_id],
        )?;
        transaction.execute("DELETE FROM file_sources WHERE id = ?1", [source_id])?;
        transaction.commit()?;
        Ok(())
    })?;
    Ok(())
}

pub fn set_state(
    db: &Db,
    source_id: &str,
    state: &str,
    last_scan_at: Option<&str>,
) -> Result<(), RepoError> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE file_sources SET state = ?2, last_scan_at = COALESCE(?3, last_scan_at) WHERE id = ?1",
            params![source_id, state, last_scan_at],
        )?;
        Ok(())
    })
}

pub fn list_files(
    db: &Db,
    role: Option<&str>,
    status: Option<&str>,
    unlinked_only: bool,
) -> Result<Vec<FileEntry>, SourceError> {
    let mut conditions = vec!["1 = 1".to_owned()];
    let mut values: Vec<Value> = Vec::new();
    if let Some(role) = role {
        values.push(Value::Text(role.to_owned()));
        conditions.push(format!("role = ?{}", values.len()));
    }
    if let Some(status) = status {
        values.push(Value::Text(status.to_owned()));
        conditions.push(format!("status = ?{}", values.len()));
    }
    if unlinked_only {
        conditions.push(
            "NOT EXISTS (SELECT 1 FROM links l WHERE l.from_type = 'file' AND l.from_id = files.id AND l.to_type = 'entity')"
                .to_owned(),
        );
    }
    Ok(db.with_conn(|conn| {
        repo::list_where::<FileEntry>(conn, &conditions.join(" AND "), "mtime DESC, rowid", values)
    })?)
}

pub fn import_files(
    db: &Db,
    data_dir: &Path,
    paths: &[String],
) -> Result<Vec<FileEntry>, SourceError> {
    let target_dir = imported_dir(data_dir);
    std::fs::create_dir_all(&target_dir)?;
    let source = regis_source(db, &target_dir)?;
    let mut imported = Vec::new();
    for raw_path in paths {
        let origin = Path::new(raw_path);
        let Some(file_name) = origin.file_name() else {
            continue;
        };
        if !origin.is_file() {
            continue;
        }
        let destination = unique_destination(&target_dir, file_name.to_string_lossy().as_ref());
        std::fs::copy(origin, &destination)?;
        imported.push(register_imported(db, &source, &destination)?);
    }
    Ok(imported)
}

pub fn import_clipboard_image(
    db: &Db,
    data_dir: &Path,
    png_base64: &str,
) -> Result<FileEntry, SourceError> {
    let bytes = decode_base64(png_base64)
        .ok_or_else(|| SourceError::Invalid("the image is not valid base64".to_owned()))?;
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err(SourceError::Invalid("the image is not a PNG".to_owned()));
    }
    let target_dir = imported_dir(data_dir);
    std::fs::create_dir_all(&target_dir)?;
    let source = regis_source(db, &target_dir)?;
    let timestamp: String = now_iso_utc()
        .chars()
        .take(19)
        .map(|character| match character {
            'T' => ' ',
            ':' => '-',
            other => other,
        })
        .collect();
    let destination = unique_destination(&target_dir, &format!("Capture {timestamp}.png"));
    std::fs::write(&destination, bytes)?;
    register_imported(db, &source, &destination)
}

pub fn regis_source(db: &Db, target_dir: &Path) -> Result<FileSource, SourceError> {
    let path_text = target_dir.to_string_lossy().into_owned();
    let sources: Vec<FileSource> = db.with_conn(|conn| {
        repo::list_where(conn, "path = ?1", "rowid", vec![Value::Text(path_text)])
    })?;
    sources
        .into_iter()
        .next()
        .ok_or_else(|| SourceError::Invalid("the imported library source is missing".to_owned()))
}

pub fn register_imported(
    db: &Db,
    source: &FileSource,
    destination: &Path,
) -> Result<FileEntry, SourceError> {
    let rel_path = destination
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let metadata = std::fs::metadata(destination)?;
    let max_bytes = load_max_file_bytes(db);
    let entry = db.with_conn(|conn| {
        register_file(conn, source, &rel_path, &metadata, max_bytes).map(|(entry, _)| entry)
    })?;
    Ok(entry)
}

pub(crate) fn unique_destination(directory: &Path, file_name: &str) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let as_path = Path::new(file_name);
    let stem = as_path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = as_path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|number| directory.join(format!("{stem} ({number}){extension}")))
        .find(|path| !path.exists())
        .unwrap_or(candidate)
}

fn decode_base64(encoded: &str) -> Option<Vec<u8>> {
    let payload = encoded
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:"))
        .map_or(encoded, |(_, data)| data);
    let mut output = Vec::with_capacity(payload.len() / 4 * 3);
    let mut accumulator = 0_u32;
    let mut bits = 0_u32;
    for byte in payload.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((accumulator >> bits) & 0xFF) as u8);
        }
    }
    Some(output)
}

pub fn link_file(
    db: &Db,
    file_id: &str,
    entity_id: &str,
    rel: &str,
) -> Result<regis_model::Link, SourceError> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err(SourceError::Invalid("the link kind is empty".to_owned()));
    }
    let link = db.with_conn(|conn| {
        repo::require::<FileEntry>(conn, file_id)?;
        repo::require::<regis_model::Entity>(conn, entity_id)?;
        let created_at = now_iso_utc();
        conn.execute(
            "INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, confidence, created_at)
             VALUES (?1, 'file', ?2, 'entity', ?3, ?4, 'user', NULL, ?5)
             ON CONFLICT (from_type, from_id, to_type, to_id, rel)
             DO UPDATE SET origin = 'user', confidence = NULL",
            params![repo::new_id(), file_id, entity_id, rel, created_at],
        )?;
        let links: Vec<regis_model::Link> = repo::list_where(
            conn,
            "from_type = 'file' AND from_id = ?1 AND to_type = 'entity' AND to_id = ?2 AND rel = ?3",
            "rowid",
            vec![
                Value::Text(file_id.to_owned()),
                Value::Text(entity_id.to_owned()),
                Value::Text(rel.to_owned()),
            ],
        )?;
        links
            .into_iter()
            .next()
            .ok_or_else(|| RepoError::NotFound("link".to_owned()))
    })?;
    Ok(link)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::db::repo::testing::test_db;
    use crate::files::embed::testing::MockOllama;
    use crate::files::indexer::index_pending;
    use crate::files::watcher::scan_source;
    use regis_model::{Entity, EntityKind};

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("regis-sources-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../../tests/fixtures/files")
    }

    fn snapshot(dir: &Path) -> BTreeMap<String, (u64, std::time::SystemTime, String)> {
        use sha2::{Digest, Sha256};
        std::fs::read_dir(dir)
            .expect("read dir")
            .map(|entry| {
                let entry = entry.expect("entry");
                let metadata = entry.metadata().expect("metadata");
                let digest = Sha256::digest(std::fs::read(entry.path()).expect("read"));
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    (
                        metadata.len(),
                        metadata.modified().expect("mtime"),
                        format!("{digest:x}"),
                    ),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn never_writes_to_watched_sources() {
        let watched = temp_dir("never-writes");
        for name in ["sample.pdf", "sample.docx", "sample.xlsx", "sample.md"] {
            std::fs::copy(fixtures_dir().join(name), watched.join(name)).expect("copy fixture");
        }
        let before = snapshot(&watched);
        let db = test_db("never-writes");
        let source = add_source(&db, "local", &watched.to_string_lossy(), None, None, true)
            .expect("add source");
        let mock = MockOllama::start();

        let report = scan_source(&db, &source.id, u64::MAX).expect("scan");
        assert_eq!(report.added, 4);
        let outcome = index_pending(&db, Some(&mock.embedder()), &|_| {}, &|_, _| {}).await;
        assert_eq!(outcome.indexed, 4);
        assert!(outcome.halted.is_none());

        assert_eq!(snapshot(&watched), before);
    }

    #[test]
    fn imports_copy_into_the_library_and_link_to_entities() {
        let data_dir = temp_dir("import-data");
        let origin = temp_dir("import-origin");
        let db = test_db("import");
        ensure_regis_sources(&db, &data_dir).expect("regis sources");
        ensure_regis_sources(&db, &data_dir).expect("regis sources again");
        assert_eq!(list_sources(&db).expect("list").len(), 3);
        assert!(library_dir(&data_dir).join("models").is_dir());
        assert!(library_dir(&data_dir).join("generated").is_dir());

        let paths: Vec<String> = ["a.pdf", "b.pdf"]
            .iter()
            .map(|name| {
                let path = origin.join(name);
                std::fs::write(&path, name.as_bytes()).expect("write");
                path.to_string_lossy().into_owned()
            })
            .collect();
        let imported = import_files(&db, &data_dir, &paths).expect("import");
        assert_eq!(imported.len(), 2);
        assert!(imported.iter().all(|entry| entry.role == "imported"));
        assert!(imported_dir(&data_dir).join("a.pdf").is_file());
        assert!(origin.join("a.pdf").is_file());

        let unlinked = list_files(&db, Some("imported"), None, true).expect("unlinked");
        assert_eq!(unlinked.len(), 2);

        let entity = Entity {
            id: repo::new_id(),
            kind: EntityKind::Client,
            name: "Atelier Rhône".to_owned(),
            tags_json: serde_json::json!([]),
            data_json: serde_json::json!({}),
            created_at: now_iso_utc(),
            updated_at: now_iso_utc(),
        };
        db.with_conn(|conn| repo::upsert(conn, &entity))
            .expect("entity");
        let link = link_file(&db, &imported[0].id, &entity.id, "attached").expect("link");
        assert_eq!(
            (
                link.from_type.as_str(),
                link.to_type.as_str(),
                link.origin.as_str()
            ),
            ("file", "entity", "user")
        );
        let unlinked = list_files(&db, Some("imported"), None, true).expect("unlinked");
        assert_eq!(unlinked.len(), 1);
        assert_eq!(unlinked[0].id, imported[1].id);
    }

    #[test]
    fn imported_file_over_the_size_limit_is_listed_but_not_indexed() {
        let data_dir = temp_dir("import-limit-data");
        let origin = temp_dir("import-limit-origin");
        let db = test_db("import-limit");
        ensure_regis_sources(&db, &data_dir).expect("regis sources");
        db.with_conn(|conn| {
            repo::set_setting(conn, crate::files::indexer::SETTING_MAX_FILE_MB, "1")
        })
        .expect("setting");
        let small = origin.join("small.md");
        let large = origin.join("large.md");
        std::fs::write(&small, b"small").expect("write small");
        std::fs::write(&large, vec![b'a'; 1024 * 1024 + 1]).expect("write large");
        let paths = vec![
            small.to_string_lossy().into_owned(),
            large.to_string_lossy().into_owned(),
        ];

        let imported = import_files(&db, &data_dir, &paths).expect("import");

        let status_of = |name: &str| {
            imported
                .iter()
                .find(|entry| entry.rel_path == name)
                .map(|entry| entry.status.clone())
        };
        assert_eq!(status_of("small.md").as_deref(), Some("pending"));
        assert_eq!(status_of("large.md").as_deref(), Some("skipped"));
    }

    #[test]
    fn clipboard_image_is_saved_but_not_indexed() {
        let data_dir = temp_dir("clipboard-data");
        let db = test_db("clipboard");
        ensure_regis_sources(&db, &data_dir).expect("regis sources");
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
        let entry = import_clipboard_image(&db, &data_dir, png).expect("import image");
        assert_eq!(
            (entry.ext.as_str(), entry.status.as_str()),
            ("png", "skipped")
        );
        assert!(imported_dir(&data_dir).join(&entry.rel_path).is_file());
        assert!(import_clipboard_image(&db, &data_dir, "bm90IGEgcG5n").is_err());
    }

    #[test]
    fn source_validation() {
        let db = test_db("validation");
        let dir = temp_dir("validation-dir");
        assert!(add_source(&db, "local", "", None, None, true).is_err());
        assert!(add_source(&db, "local", "/definitely/missing", None, None, true).is_err());
        assert!(add_source(&db, "cloud", "OneDrive", None, None, true).is_err());
        let source =
            add_source(&db, "local", &dir.to_string_lossy(), None, None, true).expect("add");
        assert_eq!(source.watch_mode, "realtime");
        assert!(add_source(&db, "local", &dir.to_string_lossy(), None, None, true).is_err());
        let network =
            add_source(&db, "smb", r"\\nas-missing\share", None, None, true).expect("smb");
        assert_eq!(
            (network.watch_mode.as_str(), network.poll_minutes),
            ("poll", Some(10))
        );
        remove_source(&db, &source.id).expect("remove");
        assert_eq!(list_sources(&db).expect("list").len(), 1);
    }
}
