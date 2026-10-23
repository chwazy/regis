use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::json;

use super::{
    column_enum, ensure_brain_connector, enum_text, list_where, new_id, text, upsert_items,
    RepoError,
};
use crate::events::now_iso_utc;
use regis_model::{
    Item, ItemKind, ItemUpsert, Recording, RecordingSources, RecordingStatus, SegmentSource,
    TranscriptSegment,
};

pub const NOTE_TYPE_TRANSCRIPT: &str = "transcript";
pub const REL_PRODUCED: &str = "produced";
pub const REL_ABOUT: &str = "about";

/// Ligne `recordings` complète (le texte de consentement et le dossier audio ne sortent pas vers l'UI).
#[derive(Debug, Clone)]
pub struct RecordingRow {
    pub id: String,
    pub title: String,
    pub status: RecordingStatus,
    pub sources: RecordingSources,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub consent_at: String,
    pub consent_text: String,
    pub stt_model: String,
    pub audio_dir: Option<String>,
    pub audio_purged_at: Option<String>,
    pub error: Option<String>,
}

impl RecordingRow {
    pub fn to_recording(&self) -> Recording {
        Recording {
            id: self.id.clone(),
            title: self.title.clone(),
            status: self.status,
            sources: self.sources,
            started_at: self.started_at.clone(),
            ended_at: self.ended_at.clone(),
            duration_ms: self.duration_ms,
            consent_at: self.consent_at.clone(),
            stt_model: self.stt_model.clone(),
            audio_available: self.audio_dir.is_some() && self.audio_purged_at.is_none(),
            error: self.error.clone(),
        }
    }
}

const COLUMNS: &str = "id, title, status, sources, started_at, ended_at, duration_ms, consent_at, consent_text, stt_model, audio_dir, audio_purged_at, error";

fn from_row(row: &Row<'_>) -> rusqlite::Result<RecordingRow> {
    let duration: Option<i64> = row.get("duration_ms")?;
    Ok(RecordingRow {
        id: row.get("id")?,
        title: row.get("title")?,
        status: column_enum(row, "status")?,
        sources: column_enum(row, "sources")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        duration_ms: duration.map(|value| value.max(0) as u64),
        consent_at: row.get("consent_at")?,
        consent_text: row.get("consent_text")?,
        stt_model: row.get("stt_model")?,
        audio_dir: row.get("audio_dir")?,
        audio_purged_at: row.get("audio_purged_at")?,
        error: row.get("error")?,
    })
}

pub fn insert_recording(conn: &Connection, row: &RecordingRow) -> Result<(), RepoError> {
    conn.execute(
        &format!(
            "INSERT INTO recordings ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"
        ),
        params![
            row.id,
            row.title,
            enum_text(&row.status)?,
            enum_text(&row.sources)?,
            row.started_at,
            row.ended_at,
            row.duration_ms.map(|value| value as i64),
            row.consent_at,
            row.consent_text,
            row.stt_model,
            row.audio_dir,
            row.audio_purged_at,
            row.error,
        ],
    )?;
    Ok(())
}

pub fn get_recording(conn: &Connection, id: &str) -> Result<Option<RecordingRow>, RepoError> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM recordings WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?)
}

pub fn require_recording(conn: &Connection, id: &str) -> Result<RecordingRow, RepoError> {
    get_recording(conn, id)?.ok_or_else(|| RepoError::NotFound(format!("recordings {id}")))
}

pub fn list_recordings_with_status(
    conn: &Connection,
    statuses: &[RecordingStatus],
) -> Result<Vec<RecordingRow>, RepoError> {
    let mut found = Vec::new();
    for status in statuses {
        let mut statement = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM recordings WHERE status = ?1 ORDER BY started_at"
        ))?;
        let rows = statement.query_map([enum_label(status)?], from_row)?;
        for row in rows {
            found.push(row?);
        }
    }
    Ok(found)
}

fn enum_label<T: serde::Serialize>(value: &T) -> Result<String, RepoError> {
    match enum_text(value)? {
        Value::Text(label) => Ok(label),
        other => Err(RepoError::Invalid(format!("not a string enum: {other:?}"))),
    }
}

pub fn set_recording_status(
    conn: &Connection,
    id: &str,
    status: RecordingStatus,
) -> Result<(), RepoError> {
    conn.execute(
        "UPDATE recordings SET status = ?2 WHERE id = ?1",
        params![id, enum_label(&status)?],
    )?;
    Ok(())
}

pub fn finish_recording(
    conn: &Connection,
    id: &str,
    status: RecordingStatus,
    ended_at: &str,
    duration_ms: u64,
    error: Option<&str>,
) -> Result<(), RepoError> {
    conn.execute(
        "UPDATE recordings SET status = ?2, ended_at = ?3, duration_ms = ?4, error = ?5 WHERE id = ?1",
        params![id, enum_label(&status)?, ended_at, duration_ms as i64, error],
    )?;
    Ok(())
}

pub fn delete_recording(conn: &Connection, id: &str) -> Result<(), RepoError> {
    conn.execute("DELETE FROM recordings WHERE id = ?1", [id])?;
    Ok(())
}

pub fn mark_audio_purged(conn: &Connection, id: &str, at: &str) -> Result<(), RepoError> {
    conn.execute(
        "UPDATE recordings SET audio_purged_at = ?2 WHERE id = ?1",
        params![id, at],
    )?;
    Ok(())
}

/// Enregistrements terminés (ni en cours ni en finalisation) dont l'audio existe encore et dont
/// la fin est antérieure à `cutoff` (ISO 8601 UTC : l'ordre lexicographique est chronologique).
pub fn list_purge_candidates(
    conn: &Connection,
    cutoff: &str,
) -> Result<Vec<RecordingRow>, RepoError> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM recordings
         WHERE status IN ('done', 'failed', 'cancelled') AND audio_dir IS NOT NULL
           AND audio_purged_at IS NULL AND ended_at IS NOT NULL AND ended_at < ?1
         ORDER BY ended_at"
    ))?;
    let rows = statement.query_map([cutoff], from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn append_segment(
    conn: &Connection,
    recording_id: &str,
    segment: &TranscriptSegment,
) -> Result<(), RepoError> {
    conn.execute(
        "INSERT INTO transcript_segments (recording_id, source, start_ms, end_ms, text)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            recording_id,
            enum_label(&segment.source)?,
            segment.start_ms as i64,
            segment.end_ms as i64,
            segment.text
        ],
    )?;
    Ok(())
}

pub fn list_segments(
    conn: &Connection,
    recording_id: &str,
) -> Result<Vec<TranscriptSegment>, RepoError> {
    let mut statement = conn.prepare(
        "SELECT source, start_ms, end_ms, text FROM transcript_segments
         WHERE recording_id = ?1 ORDER BY start_ms, id",
    )?;
    let rows = statement.query_map([recording_id], |row| {
        let start: i64 = row.get("start_ms")?;
        let end: i64 = row.get("end_ms")?;
        Ok(TranscriptSegment {
            source: column_enum::<SegmentSource>(row, "source")?,
            start_ms: start.max(0) as u64,
            end_ms: end.max(0) as u64,
            text: row.get("text")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn insert_link(
    conn: &Connection,
    from: (&str, &str),
    to: (&str, &str),
    rel: &str,
    origin: &str,
) -> Result<bool, RepoError> {
    let inserted = conn.execute(
        "INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, confidence, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)
         ON CONFLICT (from_type, from_id, to_type, to_id, rel) DO NOTHING",
        params![new_id(), from.0, from.1, to.0, to.1, rel, origin, now_iso_utc()],
    )?;
    Ok(inserted > 0)
}

/// Crée la note transcript (statut `live`) du connecteur `brain`, une par enregistrement.
pub fn create_transcript_note(
    conn: &mut Connection,
    recording: &RecordingRow,
) -> Result<Item, RepoError> {
    let connector = ensure_brain_connector(conn)?;
    // Identifiant propre à la note : la relation recording → note n'existe que dans `links`.
    let external_id = new_id();
    upsert_items(
        conn,
        &[ItemUpsert {
            connector_id: connector.id.clone(),
            kind: ItemKind::Note,
            external_id: external_id.clone(),
            title: recording.title.clone(),
            body_text: Some(String::new()),
            occurred_at: Some(recording.started_at.clone()),
            data_json: transcript_data(&recording.started_at, None, &recording.stt_model, "live"),
            updated_at: now_iso_utc(),
        }],
    )?;
    let items: Vec<Item> = list_where(
        conn,
        "connector_id = ?1 AND kind = 'note' AND external_id = ?2",
        "rowid",
        vec![text(&connector.id), text(&external_id)],
    )?;
    items
        .into_iter()
        .next()
        .ok_or_else(|| RepoError::NotFound("transcript note".to_owned()))
}

/// `dataJson` d'une note transcript : aucun identifiant d'événement, d'entité ou d'enregistrement.
pub fn transcript_data(
    started_at: &str,
    duration_ms: Option<u64>,
    stt_model: &str,
    status: &str,
) -> serde_json::Value {
    json!({
        "noteType": NOTE_TYPE_TRANSCRIPT,
        "status": status,
        "startedAt": started_at,
        "durationMs": duration_ms,
        "sttModel": stt_model,
    })
}

pub fn update_transcript_note(
    conn: &Connection,
    note_id: &str,
    body: &str,
    data_json: &serde_json::Value,
) -> Result<(), RepoError> {
    conn.execute(
        "UPDATE items SET body_text = ?2, data_json = ?3, updated_at = ?4 WHERE id = ?1",
        params![note_id, body, data_json.to_string(), now_iso_utc()],
    )?;
    Ok(())
}

pub fn transcript_item_id(
    conn: &Connection,
    recording_id: &str,
) -> Result<Option<String>, RepoError> {
    Ok(conn
        .query_row(
            "SELECT to_id FROM links WHERE from_type = 'recording' AND from_id = ?1
               AND to_type = 'item' AND rel = 'produced' ORDER BY rowid LIMIT 1",
            [recording_id],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn recording_of_transcript(
    conn: &Connection,
    note_id: &str,
) -> Result<Option<RecordingRow>, RepoError> {
    let recording_id: Option<String> = conn
        .query_row(
            "SELECT from_id FROM links WHERE from_type = 'recording' AND to_type = 'item'
               AND to_id = ?1 AND rel = 'produced' ORDER BY rowid LIMIT 1",
            [note_id],
            |row| row.get(0),
        )
        .optional()?;
    match recording_id {
        Some(id) => get_recording(conn, &id),
        None => Ok(None),
    }
}

pub fn event_of_transcript(conn: &Connection, note_id: &str) -> Result<Option<String>, RepoError> {
    Ok(conn
        .query_row(
            "SELECT l.to_id FROM links l JOIN items i ON i.id = l.to_id
             WHERE l.from_type = 'item' AND l.from_id = ?1 AND l.to_type = 'item'
               AND l.rel = 'about' AND i.kind = 'event' ORDER BY l.rowid LIMIT 1",
            [note_id],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn entities_of_item(conn: &Connection, item_id: &str) -> Result<Vec<String>, RepoError> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT to_id FROM links WHERE from_type = 'item' AND from_id = ?1 AND to_type = 'entity'
         ORDER BY rowid",
    )?;
    let rows = statement.query_map([item_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::testing::test_db;

    fn sample(id: &str) -> RecordingRow {
        RecordingRow {
            id: id.to_owned(),
            title: "Point client".to_owned(),
            status: RecordingStatus::Recording,
            sources: RecordingSources::Both,
            started_at: "2026-10-22T08:00:00.000Z".to_owned(),
            ended_at: None,
            duration_ms: None,
            consent_at: "2026-10-22T08:00:00.000Z".to_owned(),
            consent_text: "ok".to_owned(),
            stt_model: "fake".to_owned(),
            audio_dir: Some(format!("library/generated/recordings/{id}")),
            audio_purged_at: None,
            error: None,
        }
    }

    #[test]
    fn the_status_check_constraint_rejects_unknown_values() {
        let db = test_db("rec-check");
        db.with_conn(|conn| {
            insert_recording(conn, &sample("r1"))?;
            assert!(conn
                .execute("UPDATE recordings SET status = 'oops' WHERE id = 'r1'", [])
                .is_err());
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn deleting_a_recording_deletes_its_segments() {
        let db = test_db("rec-cascade");
        db.with_conn(|conn| {
            insert_recording(conn, &sample("r1"))?;
            let segment = TranscriptSegment {
                source: SegmentSource::Mic,
                start_ms: 0,
                end_ms: 1_000,
                text: "Bonjour".to_owned(),
            };
            append_segment(conn, "r1", &segment)?;
            assert_eq!(list_segments(conn, "r1")?, vec![segment]);
            conn.execute("DELETE FROM recordings WHERE id = 'r1'", [])?;
            let left: i64 =
                conn.query_row("SELECT COUNT(*) FROM transcript_segments", [], |r| r.get(0))?;
            assert_eq!(left, 0);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn the_transcript_note_does_not_carry_the_recording_id() {
        let db = test_db("rec-note-id");
        db.with_conn(|conn| {
            let row = sample("r1");
            insert_recording(conn, &row)?;
            let note = create_transcript_note(conn, &row)?;
            assert_ne!(note.external_id, "r1");
            assert!(!note.data_json.to_string().contains("r1"));
            insert_link(
                conn,
                ("recording", "r1"),
                ("item", &note.id),
                REL_PRODUCED,
                "auto",
            )?;
            assert_eq!(
                transcript_item_id(conn, "r1")?.as_deref(),
                Some(note.id.as_str())
            );
            assert_eq!(
                recording_of_transcript(conn, &note.id)?.map(|r| r.id),
                Some("r1".to_owned())
            );
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn audio_availability_follows_the_purge_marker() {
        let mut row = sample("r1");
        assert!(row.to_recording().audio_available);
        row.audio_purged_at = Some("2026-11-22T00:00:00.000Z".to_owned());
        assert!(!row.to_recording().audio_available);
    }
}
