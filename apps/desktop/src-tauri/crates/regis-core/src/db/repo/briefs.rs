use rusqlite::types::Value;
use rusqlite::Row;

use super::{column_json, json_text, new_id, opt_text, text, upsert, Record, RepoError};
use crate::events::now_iso_utc;
use regis_model::Brief;
use rusqlite::{params, Connection, OptionalExtension};

impl Record for Brief {
    const TABLE: &'static str = "briefs";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "date",
        "generated_at",
        "job_id",
        "headline",
        "sections_json",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Brief {
            id: row.get("id")?,
            date: row.get("date")?,
            generated_at: row.get("generated_at")?,
            job_id: row.get("job_id")?,
            headline: row.get("headline")?,
            sections_json: column_json(row, "sections_json")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.date),
            text(&self.generated_at),
            opt_text(&self.job_id),
            text(&self.headline),
            json_text(&self.sections_json),
        ])
    }
}

pub fn get_brief_by_date(conn: &Connection, date: &str) -> Result<Option<Brief>, RepoError> {
    let sql = format!(
        "SELECT {} FROM briefs WHERE date = ?1",
        <Brief as Record>::COLUMNS.join(", ")
    );
    Ok(conn
        .query_row(&sql, params![date], Brief::from_row)
        .optional()?)
}

pub fn save_brief(
    conn: &Connection,
    date: &str,
    job_id: Option<String>,
    headline: String,
    sections_json: serde_json::Value,
) -> Result<Brief, RepoError> {
    let id = get_brief_by_date(conn, date)?
        .map(|existing| existing.id)
        .unwrap_or_else(new_id);
    let brief = Brief {
        id,
        date: date.to_owned(),
        generated_at: now_iso_utc(),
        job_id,
        headline,
        sections_json,
    };
    upsert(conn, &brief)?;
    Ok(brief)
}
