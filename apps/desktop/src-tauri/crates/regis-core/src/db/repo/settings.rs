use rusqlite::{params, Connection, OptionalExtension};

use super::RepoError;
use crate::events::now_iso_utc;

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, RepoError> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

pub fn list_settings_with_prefix(
    conn: &Connection,
    prefix: &str,
) -> Result<Vec<(String, String)>, RepoError> {
    let mut statement = conn.prepare(
        "SELECT key, value FROM settings WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key",
    )?;
    let rows = statement.query_map([prefix], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<(String, String)>>>()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), RepoError> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_iso_utc()],
    )?;
    Ok(())
}
