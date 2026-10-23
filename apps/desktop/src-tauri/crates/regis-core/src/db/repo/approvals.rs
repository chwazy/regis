use rusqlite::types::Value;
use rusqlite::{params, Connection, Row};

use super::{
    column_enum, column_json, enum_text, json_text, list_where, new_id, opt_text, require, text,
    upsert, Record, RepoError,
};
use crate::events::now_iso_utc;
use regis_model::{Approval, ApprovalStatus, NewApproval};

impl Record for Approval {
    const TABLE: &'static str = "approvals";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "job_id",
        "tool",
        "input_json",
        "preview_json",
        "status",
        "decision_note",
        "created_at",
        "decided_at",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Approval {
            id: row.get("id")?,
            job_id: row.get("job_id")?,
            tool: row.get("tool")?,
            input_json: column_json(row, "input_json")?,
            preview_json: column_json(row, "preview_json")?,
            status: column_enum(row, "status")?,
            decision_note: row.get("decision_note")?,
            created_at: row.get("created_at")?,
            decided_at: row.get("decided_at")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.job_id),
            text(&self.tool),
            json_text(&self.input_json),
            json_text(&self.preview_json),
            enum_text(&self.status)?,
            opt_text(&self.decision_note),
            text(&self.created_at),
            opt_text(&self.decided_at),
        ])
    }
}

pub fn create_approval(
    conn: &Connection,
    new_approval: &NewApproval,
) -> Result<Approval, RepoError> {
    let approval = Approval {
        id: new_id(),
        job_id: new_approval.job_id.clone(),
        tool: new_approval.tool.clone(),
        input_json: new_approval.input_json.clone(),
        preview_json: new_approval.preview_json.clone(),
        status: ApprovalStatus::Pending,
        decision_note: new_approval.decision_note.clone(),
        created_at: now_iso_utc(),
        decided_at: new_approval.decided_at.clone(),
    };
    upsert(conn, &approval)?;
    Ok(approval)
}

pub fn list_approvals(
    conn: &Connection,
    status: Option<ApprovalStatus>,
) -> Result<Vec<Approval>, RepoError> {
    match status {
        Some(status) => list_where(
            conn,
            "status = ?1",
            "created_at DESC, id DESC",
            vec![enum_text(&status)?],
        ),
        None => list_where(conn, "1 = 1", "created_at DESC, id DESC", Vec::new()),
    }
}

pub fn resolve_approval(
    conn: &Connection,
    id: &str,
    status: ApprovalStatus,
    decision_note: Option<String>,
    edited_input: Option<serde_json::Value>,
) -> Result<Approval, RepoError> {
    if status == ApprovalStatus::Pending {
        return Err(RepoError::Invalid(
            "an approval cannot be resolved back to pending".to_owned(),
        ));
    }
    let current: Approval = require(conn, id)?;
    if current.status != ApprovalStatus::Pending {
        return Err(RepoError::Invalid(format!(
            "approval {id} is already resolved"
        )));
    }
    let input_json = edited_input.unwrap_or(current.input_json);
    conn.execute(
        "UPDATE approvals SET status = ?1, decision_note = ?2, input_json = ?3, decided_at = ?4 WHERE id = ?5",
        params![
            enum_text(&status)?,
            decision_note,
            input_json.to_string(),
            now_iso_utc(),
            id
        ],
    )?;
    require(conn, id)
}
