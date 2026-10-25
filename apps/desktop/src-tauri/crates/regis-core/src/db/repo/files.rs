use rusqlite::types::Value;
use rusqlite::Row;

use super::{column_json, flag, json_text, opt_int, opt_text, text, Record, RepoError};
use regis_model::{FileEntry, FileSource, Template};

impl Record for FileSource {
    const TABLE: &'static str = "file_sources";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "kind",
        "path",
        "watch_mode",
        "poll_minutes",
        "state",
        "last_scan_at",
        "connector_id",
        "indexed",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(FileSource {
            id: row.get("id")?,
            kind: row.get("kind")?,
            path: row.get("path")?,
            watch_mode: row.get("watch_mode")?,
            poll_minutes: row.get("poll_minutes")?,
            state: row.get("state")?,
            last_scan_at: row.get("last_scan_at")?,
            connector_id: row.get("connector_id")?,
            indexed: row.get("indexed")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.kind),
            text(&self.path),
            text(&self.watch_mode),
            opt_int(self.poll_minutes),
            text(&self.state),
            opt_text(&self.last_scan_at),
            opt_text(&self.connector_id),
            flag(self.indexed),
        ])
    }
}

impl Record for FileEntry {
    const TABLE: &'static str = "files";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "source_id",
        "rel_path",
        "ext",
        "size",
        "mtime",
        "sha256",
        "role",
        "status",
        "indexed_at",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(FileEntry {
            id: row.get("id")?,
            source_id: row.get("source_id")?,
            rel_path: row.get("rel_path")?,
            ext: row.get("ext")?,
            size: row.get("size")?,
            mtime: row.get("mtime")?,
            sha256: row.get("sha256")?,
            role: row.get("role")?,
            status: row.get("status")?,
            indexed_at: row.get("indexed_at")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.source_id),
            text(&self.rel_path),
            text(&self.ext),
            Value::Integer(self.size),
            text(&self.mtime),
            opt_text(&self.sha256),
            text(&self.role),
            text(&self.status),
            opt_text(&self.indexed_at),
        ])
    }
}

impl Record for Template {
    const TABLE: &'static str = "templates";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "file_id",
        "name",
        "instructions",
        "variables_json",
        "version",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Template {
            id: row.get("id")?,
            file_id: row.get("file_id")?,
            name: row.get("name")?,
            instructions: row.get("instructions")?,
            variables_json: column_json(row, "variables_json")?,
            version: row.get("version")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.file_id),
            text(&self.name),
            text(&self.instructions),
            json_text(&self.variables_json),
            Value::Integer(self.version),
        ])
    }
}
