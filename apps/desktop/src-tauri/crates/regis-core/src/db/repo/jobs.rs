use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, Row};
use serde_json::Map;

use super::{
    column_enum, column_json, enum_text, list_where, new_id, opt_text, require, text, upsert,
    Record, RepoError,
};
use crate::events::now_iso_utc;
use regis_model::{Job, JobEvent, JobStatus, NewJob, NewJobEvent};

const PATCHABLE_COLUMNS: &[(&str, &str)] = &[
    ("parentId", "parent_id"),
    ("agentId", "agent_id"),
    ("kind", "kind"),
    ("title", "title"),
    ("prompt", "prompt"),
    ("status", "status"),
    ("sessionId", "session_id"),
    ("cwd", "cwd"),
    ("costUsd", "cost_usd"),
    ("tokensIn", "tokens_in"),
    ("tokensOut", "tokens_out"),
    ("routingReason", "routing_reason"),
    ("resultText", "result_text"),
    ("error", "error"),
    ("createdAt", "created_at"),
    ("startedAt", "started_at"),
    ("endedAt", "ended_at"),
];

impl Record for Job {
    const TABLE: &'static str = "jobs";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "parent_id",
        "agent_id",
        "kind",
        "title",
        "prompt",
        "status",
        "session_id",
        "cwd",
        "cost_usd",
        "tokens_in",
        "tokens_out",
        "routing_reason",
        "result_text",
        "error",
        "created_at",
        "started_at",
        "ended_at",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Job {
            id: row.get("id")?,
            parent_id: row.get("parent_id")?,
            agent_id: row.get("agent_id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
            prompt: row.get("prompt")?,
            status: column_enum(row, "status")?,
            session_id: row.get("session_id")?,
            cwd: row.get("cwd")?,
            cost_usd: row.get("cost_usd")?,
            tokens_in: row.get("tokens_in")?,
            tokens_out: row.get("tokens_out")?,
            routing_reason: row.get("routing_reason")?,
            result_text: row.get("result_text")?,
            error: row.get("error")?,
            created_at: row.get("created_at")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            opt_text(&self.parent_id),
            text(&self.agent_id),
            text(&self.kind),
            text(&self.title),
            text(&self.prompt),
            enum_text(&self.status)?,
            opt_text(&self.session_id),
            opt_text(&self.cwd),
            Value::Real(self.cost_usd),
            Value::Integer(self.tokens_in),
            Value::Integer(self.tokens_out),
            opt_text(&self.routing_reason),
            opt_text(&self.result_text),
            opt_text(&self.error),
            text(&self.created_at),
            opt_text(&self.started_at),
            opt_text(&self.ended_at),
        ])
    }
}

#[derive(Debug, Default, Clone)]
pub struct JobFilter {
    pub status: Option<JobStatus>,
    pub limit: Option<i64>,
}

pub fn create_job(conn: &Connection, new_job: &NewJob) -> Result<Job, RepoError> {
    let job = Job {
        id: new_id(),
        parent_id: new_job.parent_id.clone(),
        agent_id: new_job.agent_id.clone(),
        kind: new_job.kind.clone(),
        title: new_job.title.clone(),
        prompt: new_job.prompt.clone(),
        status: new_job.status,
        session_id: new_job.session_id.clone(),
        cwd: new_job.cwd.clone(),
        cost_usd: 0.0,
        tokens_in: 0,
        tokens_out: 0,
        routing_reason: new_job.routing_reason.clone(),
        result_text: new_job.result_text.clone(),
        error: new_job.error.clone(),
        created_at: now_iso_utc(),
        started_at: new_job.started_at.clone(),
        ended_at: new_job.ended_at.clone(),
    };
    upsert(conn, &job)?;
    Ok(job)
}

pub fn update_job(
    conn: &Connection,
    id: &str,
    patch: &Map<String, serde_json::Value>,
) -> Result<Job, RepoError> {
    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    for (key, value) in patch {
        let column = PATCHABLE_COLUMNS
            .iter()
            .find(|(field, _)| field == key)
            .map(|(_, column)| *column)
            .ok_or_else(|| RepoError::Invalid(format!("job field {key} cannot be patched")))?;
        let bound = if key == "status" {
            let status: JobStatus = serde_json::from_value(value.clone())?;
            enum_text(&status)?
        } else {
            patch_value(key, value)?
        };
        values.push(bound);
        assignments.push(format!("{column} = ?{}", values.len()));
    }
    if !assignments.is_empty() {
        values.push(text(id));
        let sql = format!(
            "UPDATE jobs SET {} WHERE id = ?{}",
            assignments.join(", "),
            values.len()
        );
        conn.execute(&sql, params_from_iter(values))?;
    }
    require(conn, id)
}

fn patch_value(key: &str, value: &serde_json::Value) -> Result<Value, RepoError> {
    match value {
        serde_json::Value::Null => Ok(Value::Null),
        serde_json::Value::String(string) => Ok(Value::Text(string.clone())),
        serde_json::Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(integer), _) => Ok(Value::Integer(integer)),
            (None, Some(real)) => Ok(Value::Real(real)),
            _ => Err(RepoError::Invalid(format!(
                "job field {key} is not a number"
            ))),
        },
        _ => Err(RepoError::Invalid(format!(
            "job field {key} must be a string, number or null"
        ))),
    }
}

pub fn list_jobs(conn: &Connection, filter: &JobFilter) -> Result<Vec<Job>, RepoError> {
    let mut values: Vec<Value> = Vec::new();
    let condition = match filter.status {
        Some(status) => {
            values.push(enum_text(&status)?);
            "status = ?1"
        }
        None => "1 = 1",
    };
    let order = match filter.limit {
        Some(limit) => format!("created_at DESC, id DESC LIMIT {}", limit.max(0)),
        None => "created_at DESC, id DESC".to_owned(),
    };
    list_where(conn, condition, &order, values)
}

pub fn append_job_event(conn: &Connection, event: &NewJobEvent) -> Result<JobEvent, RepoError> {
    conn.execute(
        "INSERT INTO job_events (job_id, seq, at, type, summary, payload_json)
         VALUES (?1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM job_events WHERE job_id = ?1), ?2, ?3, ?4, ?5)",
        params![
            event.job_id,
            event.at,
            enum_text(&event.event_type)?,
            event.summary,
            event.payload_json.to_string(),
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(conn.query_row(
        "SELECT id, job_id, seq, at, type, summary, payload_json FROM job_events WHERE id = ?1",
        [id],
        job_event_from_row,
    )?)
}

pub fn list_job_events(conn: &Connection, job_id: &str) -> Result<Vec<JobEvent>, RepoError> {
    let mut statement = conn.prepare(
        "SELECT id, job_id, seq, at, type, summary, payload_json FROM job_events WHERE job_id = ?1 ORDER BY seq",
    )?;
    let rows = statement.query_map([job_id], job_event_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<JobEvent>>>()?)
}

fn job_event_from_row(row: &Row<'_>) -> rusqlite::Result<JobEvent> {
    Ok(JobEvent {
        id: row.get("id")?,
        job_id: row.get("job_id")?,
        seq: row.get("seq")?,
        at: row.get("at")?,
        event_type: column_enum(row, "type")?,
        summary: row.get("summary")?,
        payload_json: column_json(row, "payload_json")?,
    })
}
