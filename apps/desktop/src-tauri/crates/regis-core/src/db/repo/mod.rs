#![allow(dead_code)]

mod agents;
mod approvals;
mod brain;
mod briefs;
mod connectors;
mod dashboards;
mod entities;
mod files;
mod items;
mod jobs;
pub mod minutes;
pub mod recordings;
mod settings;

pub use agents::{list_rules, save_agent, save_policy, save_rules};
pub use approvals::{create_approval, list_approvals, resolve_approval};
pub use brain::{
    add_entity_note, add_fact, chunk_neighbors, decide_fact, ensure_brain_connector, entity_card,
    group_search, insert_links_if_absent, list_chunk_texts, list_entity_summaries, list_facts,
    list_syntheses, save_entity, save_synthesis, update_entity, EntitySave, EntityUpdate, NewFact,
    SynthesisSave,
};
pub use briefs::{get_brief_by_date, save_brief};
pub use connectors::{record_connector_sync, save_connector};
pub use dashboards::{
    list_dashboards, list_widgets, save_dashboard, save_widgets, seed_default_dashboard,
};
pub use items::{list_items, upsert_items, ItemFilter};
pub use jobs::{append_job_event, create_job, list_job_events, list_jobs, update_job, JobFilter};
pub use settings::{get_setting, list_settings_with_prefix, set_setting};

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0} not found")]
    NotFound(String),
    #[error("invalid input: {0}")]
    Invalid(String),
}

pub trait Record: Sized {
    const TABLE: &'static str;
    const COLUMNS: &'static [&'static str];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self>;
    fn values(&self) -> Result<Vec<Value>, RepoError>;
}

pub fn new_id() -> String {
    ulid::Ulid::generate().to_string()
}

pub fn upsert<T: Record>(conn: &Connection, record: &T) -> Result<(), RepoError> {
    let columns = T::COLUMNS;
    let placeholders = (1..=columns.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let assignments = columns[1..]
        .iter()
        .map(|column| format!("{column} = excluded.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {table} ({names}) VALUES ({placeholders}) ON CONFLICT ({key}) DO UPDATE SET {assignments}",
        table = T::TABLE,
        names = columns.join(", "),
        key = columns[0],
    );
    conn.execute(&sql, params_from_iter(record.values()?))?;
    Ok(())
}

pub fn get<T: Record>(conn: &Connection, id: &str) -> Result<Option<T>, RepoError> {
    let sql = format!(
        "SELECT {} FROM {} WHERE {} = ?1",
        T::COLUMNS.join(", "),
        T::TABLE,
        T::COLUMNS[0]
    );
    Ok(conn.query_row(&sql, [id], T::from_row).optional()?)
}

pub fn require<T: Record>(conn: &Connection, id: &str) -> Result<T, RepoError> {
    get(conn, id)?.ok_or_else(|| RepoError::NotFound(format!("{} {id}", T::TABLE)))
}

pub fn list<T: Record>(conn: &Connection) -> Result<Vec<T>, RepoError> {
    list_where(conn, "1 = 1", "rowid", Vec::new())
}

pub fn list_where<T: Record>(
    conn: &Connection,
    condition: &str,
    order_by: &str,
    params: Vec<Value>,
) -> Result<Vec<T>, RepoError> {
    let sql = format!(
        "SELECT {} FROM {} WHERE {condition} ORDER BY {order_by}",
        T::COLUMNS.join(", "),
        T::TABLE
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(params), T::from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<T>>>()?)
}

pub fn delete<T: Record>(conn: &Connection, id: &str) -> Result<bool, RepoError> {
    let sql = format!("DELETE FROM {} WHERE {} = ?1", T::TABLE, T::COLUMNS[0]);
    Ok(conn.execute(&sql, [id])? > 0)
}

pub(crate) fn text(value: &str) -> Value {
    Value::Text(value.to_owned())
}

pub(crate) fn opt_text(value: &Option<String>) -> Value {
    value.as_deref().map_or(Value::Null, text)
}

pub(crate) fn opt_real(value: Option<f64>) -> Value {
    value.map_or(Value::Null, Value::Real)
}

pub(crate) fn opt_int(value: Option<i64>) -> Value {
    value.map_or(Value::Null, Value::Integer)
}

pub(crate) fn flag(value: bool) -> Value {
    Value::Integer(i64::from(value))
}

pub(crate) fn json_text(value: &serde_json::Value) -> Value {
    Value::Text(value.to_string())
}

pub(crate) fn enum_text<T: Serialize>(value: &T) -> Result<Value, RepoError> {
    match serde_json::to_value(value)? {
        serde_json::Value::String(name) => Ok(Value::Text(name)),
        other => Err(RepoError::Invalid(format!("not a string enum: {other}"))),
    }
}

pub(crate) fn column_enum<T: DeserializeOwned>(row: &Row<'_>, name: &str) -> rusqlite::Result<T> {
    let index = row.as_ref().column_index(name)?;
    let raw: String = row.get(index)?;
    serde_json::from_value(serde_json::Value::String(raw)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

pub(crate) fn column_json(row: &Row<'_>, name: &str) -> rusqlite::Result<serde_json::Value> {
    let index = row.as_ref().column_index(name)?;
    let raw: String = row.get(index)?;
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

#[cfg(any(test, feature = "test-util"))]
pub mod testing;

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::json;

    use super::testing::{sample_agent, sample_connector, test_db};
    use super::*;
    use regis_model::{
        ApprovalStatus, Connector, ItemKind, ItemUpsert, JobEventType, JobStatus, NewApproval,
        NewJob, NewJobEvent,
    };

    pub(crate) fn sample_new_job(agent_id: &str) -> NewJob {
        NewJob {
            parent_id: None,
            agent_id: agent_id.to_owned(),
            kind: "task".to_owned(),
            title: "Write report".to_owned(),
            prompt: "Write the report".to_owned(),
            status: JobStatus::Queued,
            session_id: None,
            cwd: None,
            routing_reason: None,
            result_text: None,
            error: None,
            started_at: None,
            ended_at: None,
        }
    }

    fn sample_item(connector_id: &str, title: &str) -> ItemUpsert {
        ItemUpsert {
            connector_id: connector_id.to_owned(),
            kind: ItemKind::Message,
            external_id: "msg-1".to_owned(),
            title: title.to_owned(),
            body_text: None,
            occurred_at: None,
            data_json: json!({}),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
        }
    }

    #[test]
    fn items_upsert_is_idempotent() {
        let db = test_db("items-upsert");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(conn, &[sample_item("c1", "First title")])?;
            upsert_items(conn, &[sample_item("c1", "Second title")])?;
            let items = list_items(conn, &ItemFilter::default())?;
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].title, "Second title");
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn job_event_seq_increments() {
        let db = test_db("job-seq");
        db.with_conn(|conn| {
            upsert(conn, &sample_agent("a1"))?;
            let job = create_job(conn, &sample_new_job("a1"))?;
            let sequence: Vec<i64> = (0..3)
                .map(|index| {
                    append_job_event(
                        conn,
                        &NewJobEvent {
                            job_id: job.id.clone(),
                            at: "2026-01-01T00:00:00.000Z".to_owned(),
                            event_type: JobEventType::Message,
                            summary: format!("event {index}"),
                            payload_json: json!({}),
                        },
                    )
                    .map(|event| event.seq)
                })
                .collect::<Result<_, _>>()?;
            assert_eq!(sequence, [1, 2, 3]);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn connector_cascade() {
        let db = test_db("cascade");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(conn, &[sample_item("c1", "Title")])?;
            assert!(delete::<Connector>(conn, "c1")?);
            assert!(list_items(conn, &ItemFilter::default())?.is_empty());
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn approval_resolution_records_the_decision() {
        let db = test_db("approvals");
        db.with_conn(|conn| {
            upsert(conn, &sample_agent("a1"))?;
            let job = create_job(conn, &sample_new_job("a1"))?;
            let approval = create_approval(
                conn,
                &NewApproval {
                    job_id: job.id,
                    tool: "mcp__m365__send_mail".to_owned(),
                    input_json: json!({ "to": "a@b.c" }),
                    preview_json: json!({}),
                    decision_note: None,
                    decided_at: None,
                },
            )?;
            assert_eq!(approval.status, ApprovalStatus::Pending);
            let resolved = resolve_approval(
                conn,
                &approval.id,
                ApprovalStatus::Edited,
                Some("tweaked".to_owned()),
                Some(json!({ "to": "d@e.f" })),
            )?;
            assert_eq!(resolved.status, ApprovalStatus::Edited);
            assert_eq!(resolved.input_json, json!({ "to": "d@e.f" }));
            assert!(resolved.decided_at.is_some());
            let again = resolve_approval(conn, &approval.id, ApprovalStatus::Approved, None, None);
            assert!(matches!(again, Err(RepoError::Invalid(_))));
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn chunk_triggers_keep_fts_in_sync() {
        let db = test_db("fts");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO chunks (owner_type, owner_id, ord, text) VALUES ('file', 'f1', 0, 'quarterly invoice summary')",
                [],
            )?;
            let hits = |term: &str| -> rusqlite::Result<i64> {
                conn.query_row(
                    "SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH ?1",
                    [term],
                    |row| row.get(0),
                )
            };
            assert_eq!(hits("invoice")?, 1);
            conn.execute("DELETE FROM chunks", [])?;
            assert_eq!(hits("invoice")?, 0);
            Ok(())
        })
        .expect("repo calls");
    }
}
