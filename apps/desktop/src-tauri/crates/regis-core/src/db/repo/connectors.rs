use rusqlite::types::Value;
use rusqlite::{Connection, Row};

use super::{column_json, flag, json_text, new_id, opt_text, text, upsert, Record, RepoError};
use crate::events::now_iso_utc;
use regis_model::Connector;

impl Record for Connector {
    const TABLE: &'static str = "connectors";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "kind",
        "name",
        "transport",
        "command",
        "args_json",
        "url",
        "env_json",
        "secret_ref",
        "enabled",
        "sync_json",
        "status",
        "last_sync_at",
        "created_at",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Connector {
            id: row.get("id")?,
            kind: row.get("kind")?,
            name: row.get("name")?,
            transport: row.get("transport")?,
            command: row.get("command")?,
            args_json: column_json(row, "args_json")?,
            url: row.get("url")?,
            env_json: column_json(row, "env_json")?,
            secret_ref: row.get("secret_ref")?,
            enabled: row.get("enabled")?,
            sync_json: column_json(row, "sync_json")?,
            status: row.get("status")?,
            last_sync_at: row.get("last_sync_at")?,
            created_at: row.get("created_at")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.kind),
            text(&self.name),
            text(&self.transport),
            opt_text(&self.command),
            json_text(&self.args_json),
            opt_text(&self.url),
            json_text(&self.env_json),
            opt_text(&self.secret_ref),
            flag(self.enabled),
            json_text(&self.sync_json),
            text(&self.status),
            opt_text(&self.last_sync_at),
            text(&self.created_at),
        ])
    }
}

pub fn save_connector(conn: &Connection, mut connector: Connector) -> Result<Connector, RepoError> {
    if connector.id.is_empty() {
        connector.id = new_id();
    }
    if connector.created_at.is_empty() {
        connector.created_at = now_iso_utc();
    }
    upsert(conn, &connector)?;
    Ok(connector)
}

pub fn record_connector_sync(
    conn: &Connection,
    id: &str,
    status: &str,
    last_sync_at: Option<&str>,
) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE connectors SET status = ?2, last_sync_at = COALESCE(?3, last_sync_at) WHERE id = ?1",
        rusqlite::params![id, status, last_sync_at],
    )?;
    if changed == 0 {
        return Err(RepoError::NotFound(format!("connectors {id}")));
    }
    Ok(())
}
