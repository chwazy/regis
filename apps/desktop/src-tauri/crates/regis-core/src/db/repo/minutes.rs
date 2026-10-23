use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::recordings::{
    entities_of_item, event_of_transcript, insert_link, recording_of_transcript, REL_ABOUT,
};
use super::{
    ensure_brain_connector, insert_links_if_absent, list_where, require, text, upsert_items,
    RepoError,
};
use crate::events::now_iso_utc;
use crate::files::chunk::{chunk_text, DEFAULT_OVERLAP, DEFAULT_TARGET};
use crate::files::indexer::replace_item_chunks;
use regis_model::{Item, ItemKind, ItemUpsert, LinkProposalRow};

pub const NOTE_TYPE_MINUTES: &str = "minutes";
pub const REL_DERIVED_FROM: &str = "derived_from";
pub const EXTERNAL_ID_PREFIX: &str = "minutes:";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attendee {
    pub name: Option<String>,
    pub address: String,
}

/// Contexte de génération du PV : tout vient des données (`recordings`, événement, `links`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinutesContext {
    pub transcript_item_id: String,
    pub title: String,
    pub transcript: String,
    pub started_at: String,
    pub duration_ms: Option<u64>,
    pub attendees: Vec<Attendee>,
    pub entity_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinutesSave {
    pub transcript_item_id: String,
    pub title: String,
    pub body_text: String,
    pub job_id: String,
    pub agent_id: String,
}

fn require_done_transcript(conn: &Connection, id: &str) -> Result<Item, RepoError> {
    let item: Item = require(conn, id)?;
    let data = &item.data_json;
    let is_transcript = item.kind == ItemKind::Note
        && data.get("noteType").and_then(|value| value.as_str())
            == Some(super::recordings::NOTE_TYPE_TRANSCRIPT);
    if !is_transcript {
        return Err(RepoError::Invalid(format!(
            "item {id} is not a meeting transcript"
        )));
    }
    if data.get("status").and_then(|value| value.as_str()) != Some("done") {
        return Err(RepoError::Invalid(
            "the transcript is not finished yet".to_owned(),
        ));
    }
    Ok(item)
}

fn attendees_of_event(event: &Item) -> Vec<Attendee> {
    event
        .data_json
        .get("attendees")
        .and_then(|value| value.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    let address = entry.get("address")?.as_str()?.trim();
                    if address.is_empty() {
                        return None;
                    }
                    Some(Attendee {
                        name: entry
                            .get("name")
                            .and_then(|value| value.as_str())
                            .map(str::to_owned)
                            .filter(|name| !name.trim().is_empty()),
                        address: address.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn minutes_context(
    conn: &Connection,
    transcript_item_id: &str,
) -> Result<MinutesContext, RepoError> {
    let transcript = require_done_transcript(conn, transcript_item_id)?;
    let recording = recording_of_transcript(conn, transcript_item_id)?;
    let attendees = match event_of_transcript(conn, transcript_item_id)? {
        Some(event_id) => attendees_of_event(&require::<Item>(conn, &event_id)?),
        None => Vec::new(),
    };
    let started_at = recording
        .as_ref()
        .map(|row| row.started_at.clone())
        .or_else(|| transcript.occurred_at.clone())
        .unwrap_or_else(|| transcript.updated_at.clone());
    Ok(MinutesContext {
        transcript_item_id: transcript.id.clone(),
        title: transcript.title.clone(),
        transcript: transcript.body_text.clone().unwrap_or_default(),
        started_at,
        duration_ms: recording.and_then(|row| row.duration_ms),
        attendees,
        entity_ids: entities_of_item(conn, transcript_item_id)?,
    })
}

/// Note PV d'un transcript, si elle existe (une seule par transcript : `external_id = minutes:<id>`).
pub fn find_minutes(
    conn: &Connection,
    transcript_item_id: &str,
) -> Result<Option<Item>, RepoError> {
    let external_id = format!("{EXTERNAL_ID_PREFIX}{transcript_item_id}");
    let notes: Vec<Item> = list_where(
        conn,
        "kind = 'note' AND external_id = ?1",
        "rowid",
        vec![text(&external_id)],
    )?;
    Ok(notes.into_iter().next())
}

/// Crée ou met à jour la note PV (une par transcript) et ses liens, puis réindexe son texte.
pub fn save_minutes(conn: &mut Connection, input: &MinutesSave) -> Result<Item, RepoError> {
    let transcript = require_done_transcript(conn, &input.transcript_item_id)?;
    if input.body_text.trim().is_empty() {
        return Err(RepoError::Invalid("the minutes text is empty".to_owned()));
    }
    let connector = ensure_brain_connector(conn)?;
    let external_id = format!("{EXTERNAL_ID_PREFIX}{}", transcript.id);
    let generated_at = now_iso_utc();
    upsert_items(
        conn,
        &[ItemUpsert {
            connector_id: connector.id.clone(),
            kind: ItemKind::Note,
            external_id: external_id.clone(),
            title: input.title.clone(),
            body_text: Some(input.body_text.clone()),
            occurred_at: transcript.occurred_at.clone(),
            data_json: json!({
                "noteType": NOTE_TYPE_MINUTES,
                "jobId": input.job_id,
                "agentId": input.agent_id,
                "generatedAt": generated_at,
            }),
            updated_at: generated_at.clone(),
        }],
    )?;
    let note: Item = list_where::<Item>(
        conn,
        "connector_id = ?1 AND kind = 'note' AND external_id = ?2",
        "rowid",
        vec![text(&connector.id), text(&external_id)],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| RepoError::NotFound("minutes note".to_owned()))?;

    insert_link(
        conn,
        ("item", &note.id),
        ("item", &transcript.id),
        REL_DERIVED_FROM,
        "auto",
    )?;
    if let Some(event_id) = event_of_transcript(conn, &transcript.id)? {
        insert_link(
            conn,
            ("item", &note.id),
            ("item", &event_id),
            REL_ABOUT,
            "auto",
        )?;
    }
    let proposals: Vec<LinkProposalRow> = entities_of_item(conn, &transcript.id)?
        .into_iter()
        .map(|entity_id| LinkProposalRow {
            from_type: "item".to_owned(),
            from_id: note.id.clone(),
            to_entity_id: entity_id,
            rel: REL_ABOUT.to_owned(),
            confidence: None,
        })
        .collect();
    insert_links_if_absent(conn, &proposals, "auto")?;

    // Chunks seuls (FTS) : l'indexeur rattrape les vecteurs manquants des items.
    let chunks = chunk_text(&input.body_text, DEFAULT_TARGET, DEFAULT_OVERLAP);
    replace_item_chunks(conn, &note.id, &chunks, None)?;
    Ok(note)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::db::repo::recordings::{
        create_transcript_note, insert_recording, transcript_data, update_transcript_note,
        RecordingRow, REL_PRODUCED,
    };
    use crate::db::repo::testing::{sample_connector, test_db};
    use crate::db::repo::upsert;
    use regis_model::{RecordingSources, RecordingStatus};

    fn recording() -> RecordingRow {
        RecordingRow {
            id: "r1".to_owned(),
            title: "Point client".to_owned(),
            status: RecordingStatus::Done,
            sources: RecordingSources::Both,
            started_at: "2026-10-22T08:00:00.000Z".to_owned(),
            ended_at: Some("2026-10-22T09:05:00.000Z".to_owned()),
            duration_ms: Some(3_900_000),
            consent_at: "2026-10-22T08:00:00.000Z".to_owned(),
            consent_text: "ok".to_owned(),
            stt_model: "fake".to_owned(),
            audio_dir: None,
            audio_purged_at: None,
            error: None,
        }
    }

    struct Fixture {
        transcript_id: String,
        event_id: Option<String>,
    }

    fn fixture(conn: &mut Connection, with_event: bool) -> Fixture {
        let row = recording();
        insert_recording(conn, &row).expect("recording");
        let note = create_transcript_note(conn, &row).expect("note");
        update_transcript_note(
            conn,
            &note.id,
            "Bonjour, on commence.",
            &transcript_data(&row.started_at, row.duration_ms, "fake", "done"),
        )
        .expect("body");
        insert_link(
            conn,
            ("recording", "r1"),
            ("item", &note.id),
            REL_PRODUCED,
            "auto",
        )
        .expect("produced");
        insert_link(
            conn,
            ("item", &note.id),
            ("entity", "E-client"),
            REL_ABOUT,
            "auto",
        )
        .expect("entity link");
        let event_id = if with_event {
            upsert(conn, &sample_connector("c-m365")).expect("connector");
            upsert_items(
                conn,
                &[ItemUpsert {
                    connector_id: "c-m365".to_owned(),
                    kind: ItemKind::Event,
                    external_id: "evt-1".to_owned(),
                    title: "Point client".to_owned(),
                    body_text: None,
                    occurred_at: Some("2026-10-22T08:00:00.000Z".to_owned()),
                    data_json: json!({
                        "end": "2026-10-22T09:00:00.000Z",
                        "attendees": [
                            { "name": "Alice Martin", "address": "alice@example.com" },
                            { "name": null, "address": "bob@example.com" }
                        ]
                    }),
                    updated_at: "2026-10-22T07:00:00.000Z".to_owned(),
                }],
            )
            .expect("event");
            let event: Item =
                list_where::<Item>(conn, "external_id = 'evt-1'", "rowid", Vec::new())
                    .expect("find")
                    .remove(0);
            insert_link(
                conn,
                ("item", &note.id),
                ("item", &event.id),
                REL_ABOUT,
                "auto",
            )
            .expect("event link");
            Some(event.id)
        } else {
            None
        };
        Fixture {
            transcript_id: note.id,
            event_id,
        }
    }

    fn save_input(transcript_id: &str, body: &str) -> MinutesSave {
        MinutesSave {
            transcript_item_id: transcript_id.to_owned(),
            title: "PV — Point client".to_owned(),
            body_text: body.to_owned(),
            job_id: "J1".to_owned(),
            agent_id: "A1".to_owned(),
        }
    }

    #[test]
    fn context_resolves_attendees_and_entities_through_links() {
        let db = test_db("minutes-context");
        db.with_conn(|conn| {
            let fx = fixture(conn, true);
            let ctx = minutes_context(conn, &fx.transcript_id)?;
            assert_eq!(ctx.title, "Point client");
            assert_eq!(ctx.transcript, "Bonjour, on commence.");
            assert_eq!(ctx.started_at, "2026-10-22T08:00:00.000Z");
            assert_eq!(ctx.duration_ms, Some(3_900_000));
            assert_eq!(ctx.entity_ids, vec!["E-client".to_owned()]);
            assert_eq!(ctx.attendees.len(), 2);
            assert_eq!(ctx.attendees[0].address, "alice@example.com");
            assert_eq!(ctx.attendees[1].name, None);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn context_without_event_has_no_attendees() {
        let db = test_db("minutes-context-no-event");
        db.with_conn(|conn| {
            let fx = fixture(conn, false);
            assert!(minutes_context(conn, &fx.transcript_id)?
                .attendees
                .is_empty());
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn context_refuses_a_transcript_that_is_not_done() {
        let db = test_db("minutes-context-live");
        db.with_conn(|conn| {
            let row = recording();
            insert_recording(conn, &row)?;
            let note = create_transcript_note(conn, &row)?;
            assert!(matches!(
                minutes_context(conn, &note.id),
                Err(RepoError::Invalid(_))
            ));
            Ok(())
        })
        .expect("repo calls");
    }

    fn count_links(conn: &Connection, rel: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM links WHERE from_type = 'item' AND rel = ?1
               AND from_id IN (SELECT id FROM items WHERE external_id LIKE 'minutes:%')",
            [rel],
            |row| row.get(0),
        )
        .expect("count")
    }

    #[test]
    fn save_creates_the_note_and_links_then_updates_it_in_place() {
        let db = test_db("minutes-save");
        db.with_conn(|conn| {
            let fx = fixture(conn, true);
            let event_id = fx.event_id.clone().unwrap_or_default();
            let first = save_minutes(conn, &save_input(&fx.transcript_id, "# PV\n\nTexte"))?;
            assert_eq!(first.external_id, format!("minutes:{}", fx.transcript_id));
            assert_eq!(first.data_json["noteType"], "minutes");
            assert_eq!(first.data_json["jobId"], "J1");
            let data = first.data_json.to_string();
            assert!(!data.contains("E-client") && !data.contains(&event_id));

            let derived: i64 = conn.query_row(
                "SELECT COUNT(*) FROM links WHERE from_id = ?1 AND to_type = 'item' AND to_id = ?2 AND rel = 'derived_from'",
                [&first.id, &fx.transcript_id],
                |row| row.get(0),
            )?;
            assert_eq!(derived, 1);
            let about_event: i64 = conn.query_row(
                "SELECT COUNT(*) FROM links WHERE from_id = ?1 AND to_type = 'item' AND to_id = ?2 AND rel = 'about'",
                [&first.id, &event_id],
                |row| row.get(0),
            )?;
            assert_eq!(about_event, 1);
            let about_entity: i64 = conn.query_row(
                "SELECT COUNT(*) FROM links WHERE from_id = ?1 AND to_type = 'entity' AND to_id = 'E-client' AND rel = 'about' AND origin = 'auto'",
                [&first.id],
                |row| row.get(0),
            )?;
            assert_eq!(about_entity, 1);

            assert_eq!(
                find_minutes(conn, &fx.transcript_id)?.map(|note| note.id),
                Some(first.id.clone())
            );
            let second =
                save_minutes(conn, &save_input(&fx.transcript_id, "# PV\n\nAutre texte"))?;
            assert_eq!(second.id, first.id);
            assert_eq!(second.body_text.as_deref(), Some("# PV\n\nAutre texte"));
            let notes: i64 = conn.query_row(
                "SELECT COUNT(*) FROM items WHERE external_id LIKE 'minutes:%'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(notes, 1);
            assert_eq!(count_links(conn, "derived_from"), 1);
            assert_eq!(count_links(conn, "about"), 2);
            let chunks: i64 = conn.query_row(
                "SELECT COUNT(*) FROM chunks WHERE owner_type = 'item' AND owner_id = ?1",
                [&first.id],
                |row| row.get(0),
            )?;
            assert!(chunks >= 1);
            Ok(())
        })
        .expect("repo calls");
    }
}
