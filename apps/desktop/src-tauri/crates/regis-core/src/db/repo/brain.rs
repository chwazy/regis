use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime};

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::json;

use super::{
    delete, get, list, list_where, new_id, require, save_connector, text, upsert, upsert_items,
    RepoError,
};
use crate::events::{iso_utc, now_iso_utc};
use regis_model::SearchHit;
use regis_model::{
    ChunkNeighbor, ChunkText, Connector, DocumentHit, Entity, EntityCard, EntityKind, EntityNote,
    EntityStats, EntitySummary, EntitySynthesis, Fact, FactDecision, FactSource, FactStatus,
    FactView, FileEntry, GlobalSearchResult, Item, ItemKind, ItemUpsert, Job, Link,
    LinkProposalRow, LinkedDocument, LinkedEntity, MailHit, NoteHit, ProjectSummary, TimelineEntry,
};

pub const BRAIN_CONNECTOR_KIND: &str = "brain";
pub const BRAIN_CONNECTOR_NAME: &str = "Second cerveau";

const TIMELINE_LIMIT: usize = 60;
const NOTE_TITLE_LIMIT: usize = 80;
const SNIPPET_LIMIT: usize = 160;
const ENTITY_SEARCH_LIMIT: usize = 8;
const MAIL_TITLE_SEARCH_LIMIT: usize = 5;
const NEIGHBOR_POOL: i64 = 60;
const NEIGHBOR_SOURCE_CHUNKS: i64 = 20;
const MINUTES_PER_HOUR: f64 = 60.0;
const TAG_MAX_CHARS: usize = 40;
const STATS_WINDOW: Duration = Duration::from_secs(30 * 86_400);
const NOTES_LIMIT: usize = 20;
const TAGS_MAX: usize = 20;

pub fn ensure_brain_connector(conn: &Connection) -> Result<Connector, RepoError> {
    let existing: Vec<Connector> = list_where(
        conn,
        "kind = ?1",
        "rowid",
        vec![Value::Text(BRAIN_CONNECTOR_KIND.to_owned())],
    )?;
    if let Some(connector) = existing.into_iter().next() {
        return Ok(connector);
    }
    save_connector(
        conn,
        Connector {
            id: String::new(),
            kind: BRAIN_CONNECTOR_KIND.to_owned(),
            name: BRAIN_CONNECTOR_NAME.to_owned(),
            transport: "builtin".to_owned(),
            command: None,
            args_json: json!([]),
            url: None,
            env_json: json!({}),
            secret_ref: None,
            enabled: true,
            sync_json: json!({}),
            status: "ok".to_owned(),
            last_sync_at: None,
            created_at: String::new(),
        },
    )
}

pub struct EntitySave {
    pub id: Option<String>,
    pub kind: EntityKind,
    pub name: String,
    pub tags_json: serde_json::Value,
    pub data_json: serde_json::Value,
}

pub fn save_entity(conn: &Connection, input: EntitySave) -> Result<Entity, RepoError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(RepoError::Invalid("the entity name is empty".to_owned()));
    }
    let now = now_iso_utc();
    let (id, created_at) = match input.id {
        Some(id) => {
            let existing: Entity = require(conn, &id)?;
            (id, existing.created_at)
        }
        None => (new_id(), now.clone()),
    };
    let entity = Entity {
        id,
        kind: input.kind,
        name: name.to_owned(),
        tags_json: input.tags_json,
        data_json: input.data_json,
        created_at,
        updated_at: now,
    };
    upsert(conn, &entity)?;
    Ok(entity)
}

pub struct EntityUpdate {
    pub kind: Option<EntityKind>,
    pub tags: Option<Vec<String>>,
}

pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for tag in tags {
        let collapsed = tag
            .trim()
            .trim_start_matches('#')
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let tag: String = collapsed.chars().take(TAG_MAX_CHARS).collect();
        if tag.is_empty() || !seen.insert(tag.to_lowercase()) {
            continue;
        }
        normalized.push(tag);
        if normalized.len() == TAGS_MAX {
            break;
        }
    }
    normalized
}

pub fn update_entity(
    conn: &Connection,
    id: &str,
    update: EntityUpdate,
) -> Result<Entity, RepoError> {
    let mut entity: Entity = require(conn, id)?;
    if let Some(kind) = update.kind {
        entity.kind = kind;
    }
    if let Some(tags) = update.tags {
        entity.tags_json = json!(normalize_tags(&tags));
    }
    entity.updated_at = now_iso_utc();
    upsert(conn, &entity)?;
    Ok(entity)
}

pub struct SynthesisSave {
    pub entity_id: String,
    pub text: String,
    pub source_count: i64,
    pub signature: String,
    pub job_id: Option<String>,
}

fn synthesis_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EntitySynthesis> {
    Ok(EntitySynthesis {
        entity_id: row.get(0)?,
        text: row.get(1)?,
        source_count: row.get(2)?,
        signature: row.get(3)?,
        job_id: row.get(4)?,
        generated_at: row.get(5)?,
    })
}

const SYNTHESIS_COLUMNS: &str = "entity_id, text, source_count, signature, job_id, generated_at";

pub fn save_synthesis(
    conn: &Connection,
    input: SynthesisSave,
) -> Result<EntitySynthesis, RepoError> {
    let text = input.text.trim();
    if text.is_empty() {
        return Err(RepoError::Invalid("the synthesis is empty".to_owned()));
    }
    require::<Entity>(conn, &input.entity_id)?;
    let synthesis = EntitySynthesis {
        entity_id: input.entity_id,
        text: text.to_owned(),
        source_count: input.source_count,
        signature: input.signature,
        job_id: input.job_id,
        generated_at: now_iso_utc(),
    };
    conn.execute(
        &format!("INSERT OR REPLACE INTO entity_syntheses ({SYNTHESIS_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"),
        params![
            synthesis.entity_id,
            synthesis.text,
            synthesis.source_count,
            synthesis.signature,
            synthesis.job_id,
            synthesis.generated_at
        ],
    )?;
    Ok(synthesis)
}

pub fn list_syntheses(conn: &Connection) -> Result<Vec<EntitySynthesis>, RepoError> {
    let mut statement = conn.prepare(&format!(
        "SELECT {SYNTHESIS_COLUMNS} FROM entity_syntheses ORDER BY generated_at DESC"
    ))?;
    let rows = statement.query_map([], synthesis_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn get_synthesis(conn: &Connection, entity_id: &str) -> Result<Option<EntitySynthesis>, RepoError> {
    Ok(conn
        .query_row(
            &format!("SELECT {SYNTHESIS_COLUMNS} FROM entity_syntheses WHERE entity_id = ?1"),
            [entity_id],
            synthesis_from_row,
        )
        .optional()?)
}

pub fn entity_stats(items: &[Item], now: SystemTime) -> EntityStats {
    let cutoff = iso_utc(now.checked_sub(STATS_WINDOW).unwrap_or(now));
    let now_text = iso_utc(now);
    let hours_last_30_days = items
        .iter()
        .filter(|item| item.kind == ItemKind::TimeEntry)
        .filter(|item| {
            item.occurred_at
                .as_deref()
                .is_some_and(|at| at >= cutoff.as_str() && at <= now_text.as_str())
        })
        .filter_map(|item| item.data_json.get("hours").and_then(|value| value.as_f64()))
        .sum();
    let last_message_at = items
        .iter()
        .filter(|item| item.kind == ItemKind::Message)
        .filter_map(|item| item.occurred_at.clone())
        .filter(|at| at.as_str() <= now_text.as_str())
        .max();
    EntityStats {
        hours_last_30_days,
        last_message_at,
    }
}

pub fn insert_links_if_absent(
    conn: &Connection,
    rows: &[LinkProposalRow],
    origin: &str,
) -> Result<usize, RepoError> {
    let created_at = now_iso_utc();
    let mut inserted = 0;
    for row in rows {
        inserted += conn.execute(
            "INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, confidence, created_at)
             VALUES (?1, ?2, ?3, 'entity', ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (from_type, from_id, to_type, to_id, rel) DO NOTHING",
            params![
                new_id(),
                row.from_type,
                row.from_id,
                row.to_entity_id,
                row.rel,
                origin,
                row.confidence,
                created_at
            ],
        )?;
    }
    Ok(inserted)
}

pub struct NewFact {
    pub entity_id: String,
    pub text: String,
    pub source_type: String,
    pub source_id: String,
    pub status: FactStatus,
}

pub fn add_fact(conn: &Connection, input: NewFact) -> Result<Fact, RepoError> {
    let body = input.text.trim();
    if body.is_empty() {
        return Err(RepoError::Invalid("the fact text is empty".to_owned()));
    }
    require::<Entity>(conn, &input.entity_id)?;
    let fact = Fact {
        id: new_id(),
        entity_id: input.entity_id,
        text: body.to_owned(),
        source_type: input.source_type,
        source_id: input.source_id,
        status: input.status,
        created_at: now_iso_utc(),
    };
    upsert(conn, &fact)?;
    Ok(fact)
}

pub fn list_facts(conn: &Connection, entity_id: Option<&str>) -> Result<Vec<Fact>, RepoError> {
    match entity_id {
        Some(id) => list_where(
            conn,
            "entity_id = ?1",
            "created_at, rowid",
            vec![Value::Text(id.to_owned())],
        ),
        None => list_where(conn, "1 = 1", "created_at, rowid", Vec::new()),
    }
}

pub fn decide_fact(
    conn: &Connection,
    id: &str,
    decision: FactDecision,
) -> Result<Option<Fact>, RepoError> {
    let status = match decision {
        FactDecision::Rejected => {
            if !delete::<Fact>(conn, id)? {
                return Err(RepoError::NotFound(format!("facts {id}")));
            }
            return Ok(None);
        }
        FactDecision::Confirmed => FactStatus::Confirmed,
        FactDecision::ToVerify => FactStatus::ToVerify,
        FactDecision::Inferred => FactStatus::Inferred,
    };
    let mut fact: Fact = require(conn, id)?;
    fact.status = status;
    upsert(conn, &fact)?;
    Ok(Some(fact))
}

pub fn list_chunk_texts(
    conn: &Connection,
    owner_type: &str,
    owner_id: &str,
) -> Result<Vec<ChunkText>, RepoError> {
    let mut statement = conn.prepare(
        "SELECT id, text FROM chunks WHERE owner_type = ?1 AND owner_id = ?2 ORDER BY ord",
    )?;
    let rows = statement.query_map(params![owner_type, owner_id], |row| {
        Ok(ChunkText {
            id: row.get(0)?,
            text: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<ChunkText>>>()?)
}

pub fn chunk_neighbors(conn: &Connection, file_id: &str) -> Result<Vec<ChunkNeighbor>, RepoError> {
    let mut statement = conn.prepare(
        "SELECT id FROM chunks WHERE owner_type = 'file' AND owner_id = ?1 ORDER BY ord LIMIT ?2",
    )?;
    let source_ids = statement
        .query_map(params![file_id, NEIGHBOR_SOURCE_CHUNKS], |row| {
            row.get::<_, i64>(0)
        })?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    let mut best: HashMap<String, f64> = HashMap::new();
    for chunk_id in source_ids {
        let blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT embedding FROM chunks_vec WHERE rowid = ?1",
                [chunk_id],
                |row| row.get(0),
            )
            .ok();
        let Some(blob) = blob else {
            continue;
        };
        let mut knn = conn.prepare(
            "SELECT v.distance, c.owner_type, c.owner_id FROM chunks_vec v
             JOIN chunks c ON c.id = v.rowid
             WHERE v.embedding MATCH ?1 AND k = ?2 ORDER BY v.distance",
        )?;
        let rows = knn.query_map(params![blob, NEIGHBOR_POOL], |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (distance, owner_type, owner_id) = row?;
            if owner_type != "file" || owner_id == file_id {
                continue;
            }
            best.entry(owner_id)
                .and_modify(|current| *current = current.min(distance))
                .or_insert(distance);
        }
    }
    let mut neighbors: Vec<ChunkNeighbor> = best
        .into_iter()
        .map(|(owner_id, distance)| ChunkNeighbor { owner_id, distance })
        .collect();
    neighbors.sort_by(|left, right| {
        left.distance
            .total_cmp(&right.distance)
            .then_with(|| left.owner_id.cmp(&right.owner_id))
    });
    Ok(neighbors)
}

fn belongs_to_links(conn: &Connection) -> Result<Vec<(String, String)>, RepoError> {
    let mut statement = conn.prepare(
        "SELECT from_id, to_id FROM links WHERE from_type = 'entity' AND to_type = 'entity' AND rel = 'belongs_to'",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<(String, String)>>>()?)
}

fn kind_rank(kind: EntityKind) -> u8 {
    match kind {
        EntityKind::Client => 0,
        EntityKind::Project => 1,
        EntityKind::Contact => 2,
        EntityKind::Other => 3,
    }
}

fn contact_email(entity: &Entity) -> Option<&str> {
    entity
        .data_json
        .get("email")
        .and_then(|value| value.as_str())
}

pub fn list_entity_summaries(
    conn: &Connection,
    kind: Option<EntityKind>,
    query: Option<&str>,
) -> Result<Vec<EntitySummary>, RepoError> {
    let all: Vec<Entity> = list(conn)?;
    let names: HashMap<&str, &str> = all
        .iter()
        .map(|entity| (entity.id.as_str(), entity.name.as_str()))
        .collect();
    let links = belongs_to_links(conn)?;
    let mut child_counts: HashMap<&str, usize> = HashMap::new();
    let mut owners: HashMap<&str, &str> = HashMap::new();
    for (from_id, to_id) in &links {
        owners.insert(from_id.as_str(), to_id.as_str());
        if all
            .iter()
            .any(|entity| entity.id == *from_id && entity.kind == EntityKind::Project)
        {
            *child_counts.entry(to_id.as_str()).or_default() += 1;
        }
    }
    let needle = query.map(|value| value.trim().to_lowercase());
    let mut summaries: Vec<EntitySummary> = all
        .iter()
        .filter(|entity| kind.is_none_or(|wanted| entity.kind == wanted))
        .filter(|entity| {
            needle
                .as_deref()
                .is_none_or(|needle| entity.name.to_lowercase().contains(needle))
        })
        .map(|entity| {
            let meta = match entity.kind {
                EntityKind::Client => match child_counts.get(entity.id.as_str()).copied() {
                    None | Some(0) => "client".to_owned(),
                    Some(1) => "1 projet".to_owned(),
                    Some(count) => format!("{count} projets"),
                },
                EntityKind::Project => owners
                    .get(entity.id.as_str())
                    .and_then(|owner| names.get(owner))
                    .map_or_else(|| "projet".to_owned(), |name| (*name).to_owned()),
                EntityKind::Contact => contact_email(entity).unwrap_or("contact").to_owned(),
                EntityKind::Other => "autre".to_owned(),
            };
            EntitySummary {
                entity: entity.clone(),
                meta,
            }
        })
        .collect();
    summaries.sort_by_key(|summary| summary.entity.name.to_lowercase());
    Ok(summaries)
}

pub fn search_entities_by_prefix(conn: &Connection, query: &str) -> Result<Vec<Entity>, RepoError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let all: Vec<Entity> = list(conn)?;
    let starts_whole = |entity: &Entity| entity.name.to_lowercase().starts_with(&needle);
    let mut matches: Vec<Entity> = all
        .iter()
        .filter(|entity| {
            starts_whole(entity)
                || entity
                    .name
                    .to_lowercase()
                    .split(|character: char| !character.is_alphanumeric())
                    .any(|word| word.starts_with(&needle))
        })
        .cloned()
        .collect();
    matches.sort_by(|left, right| {
        starts_whole(right)
            .cmp(&starts_whole(left))
            .then_with(|| kind_rank(left.kind).cmp(&kind_rank(right.kind)))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    matches.truncate(ENTITY_SEARCH_LIMIT);
    Ok(matches)
}

fn clip(value: &str, limit: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= limit {
        return collapsed;
    }
    let clipped: String = collapsed.chars().take(limit.saturating_sub(1)).collect();
    format!("{clipped}…")
}

fn first_entity_of(
    conn: &Connection,
    from_type: &str,
    from_id: &str,
) -> Result<Option<String>, RepoError> {
    Ok(conn
        .query_row(
            "SELECT to_id FROM links WHERE from_type = ?1 AND from_id = ?2 AND to_type = 'entity'
             ORDER BY confidence IS NOT NULL, confidence DESC, rowid LIMIT 1",
            params![from_type, from_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub fn group_search(
    conn: &Connection,
    query: &str,
    hits: &[SearchHit],
) -> Result<GlobalSearchResult, RepoError> {
    let entities = search_entities_by_prefix(conn, query)?;
    let mut documents: Vec<DocumentHit> = Vec::new();
    let mut mails: Vec<MailHit> = Vec::new();
    let mut notes: Vec<NoteHit> = Vec::new();
    for hit in hits {
        match hit.owner_type.as_str() {
            "file" => {
                if documents.iter().any(|known| known.file_id == hit.owner_id) {
                    continue;
                }
                if let Some(file) = get::<FileEntry>(conn, &hit.owner_id)? {
                    documents.push(DocumentHit {
                        entity_id: first_entity_of(conn, "file", &file.id)?,
                        file_id: file.id,
                        name: file.rel_path,
                        snippet: clip(&hit.text, SNIPPET_LIMIT),
                    });
                }
            }
            "item" => {
                if mails.iter().any(|known| known.item_id == hit.owner_id)
                    || notes.iter().any(|known| known.item_id == hit.owner_id)
                {
                    continue;
                }
                if let Some(item) = get::<Item>(conn, &hit.owner_id)? {
                    if item.kind == ItemKind::Note {
                        notes.push(NoteHit {
                            note_type: note_type_of(&item).unwrap_or_else(|| "note".to_owned()),
                            item_id: item.id,
                            title: item.title,
                            snippet: clip(&hit.text, SNIPPET_LIMIT),
                        });
                        continue;
                    }
                    mails.push(MailHit {
                        entity_id: first_entity_of(conn, "item", &item.id)?,
                        item_id: item.id,
                        title: item.title,
                        snippet: clip(&hit.text, SNIPPET_LIMIT),
                    });
                }
            }
            _ => {}
        }
    }
    if !query.trim().is_empty() {
        let by_title: Vec<Item> = list_where(
            conn,
            "kind = 'message' AND title LIKE ?1 ESCAPE '\\'",
            "occurred_at DESC, rowid DESC",
            vec![Value::Text(format!("%{}%", escape_like(query.trim())))],
        )?;
        for item in by_title.into_iter().take(MAIL_TITLE_SEARCH_LIMIT) {
            if mails.iter().any(|known| known.item_id == item.id) {
                continue;
            }
            mails.push(MailHit {
                entity_id: first_entity_of(conn, "item", &item.id)?,
                snippet: clip(item.body_text.as_deref().unwrap_or(""), SNIPPET_LIMIT),
                item_id: item.id,
                title: item.title,
            });
        }
    }
    Ok(GlobalSearchResult {
        entities,
        documents,
        mails,
        notes,
    })
}

/// `dataJson.noteType` d'une note (`transcript`, `minutes`…), absent pour une note libre.
pub fn note_type_of(item: &Item) -> Option<String> {
    item.data_json
        .get("noteType")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

pub fn add_entity_note(
    conn: &mut Connection,
    entity_id: &str,
    body: &str,
) -> Result<Item, RepoError> {
    let body = body.trim();
    if body.is_empty() {
        return Err(RepoError::Invalid("the note is empty".to_owned()));
    }
    require::<Entity>(conn, entity_id)?;
    let connector = ensure_brain_connector(conn)?;
    let now = now_iso_utc();
    let external_id = new_id();
    let first_line = body.lines().next().unwrap_or(body);
    upsert_items(
        conn,
        &[ItemUpsert {
            connector_id: connector.id.clone(),
            kind: ItemKind::Note,
            external_id: external_id.clone(),
            title: clip(first_line, NOTE_TITLE_LIMIT),
            body_text: Some(body.to_owned()),
            occurred_at: Some(now.clone()),
            data_json: json!({}),
            updated_at: now,
        }],
    )?;
    let items: Vec<Item> = list_where(
        conn,
        "connector_id = ?1 AND kind = 'note' AND external_id = ?2",
        "rowid",
        vec![Value::Text(connector.id), Value::Text(external_id)],
    )?;
    let item = items
        .into_iter()
        .next()
        .ok_or_else(|| RepoError::NotFound("note item".to_owned()))?;
    insert_links_if_absent(
        conn,
        &[LinkProposalRow {
            from_type: "item".to_owned(),
            from_id: item.id.clone(),
            to_entity_id: entity_id.to_owned(),
            rel: "about".to_owned(),
            confidence: None,
        }],
        "user",
    )?;
    Ok(item)
}

fn source_of(conn: &Connection, fact: &Fact) -> Result<FactSource, RepoError> {
    let missing = |kind: &str| FactSource {
        kind: kind.to_owned(),
        id: fact.source_id.clone(),
        label: "source supprimée".to_owned(),
        file_id: None,
    };
    let source = match fact.source_type.as_str() {
        "item" => match get::<Item>(conn, &fact.source_id)? {
            Some(item) => FactSource {
                kind: "item".to_owned(),
                id: item.id,
                label: item.title,
                file_id: None,
            },
            None => missing("item"),
        },
        "chunk" => {
            let owner: Option<String> = fact.source_id.parse::<i64>().ok().and_then(|chunk_id| {
                conn.query_row(
                    "SELECT owner_id FROM chunks WHERE id = ?1 AND owner_type = 'file'",
                    [chunk_id],
                    |row| row.get(0),
                )
                .ok()
            });
            match owner.and_then(|file_id| get::<FileEntry>(conn, &file_id).ok().flatten()) {
                Some(file) => FactSource {
                    kind: "file".to_owned(),
                    id: fact.source_id.clone(),
                    label: file.rel_path,
                    file_id: Some(file.id),
                },
                None => missing("file"),
            }
        }
        "job" => match get::<Job>(conn, &fact.source_id)? {
            Some(job) => FactSource {
                kind: "job".to_owned(),
                id: job.id,
                label: job.title,
                file_id: None,
            },
            None => missing("job"),
        },
        other => FactSource {
            kind: other.to_owned(),
            id: fact.source_id.clone(),
            label: other.to_owned(),
            file_id: None,
        },
    };
    Ok(source)
}

pub fn format_hours(hours: f64) -> String {
    let whole = hours.trunc();
    let minutes = ((hours - whole) * MINUTES_PER_HOUR).round();
    if minutes <= 0.0 {
        format!("{whole}h")
    } else if minutes >= MINUTES_PER_HOUR {
        format!("{}h", whole + 1.0)
    } else {
        format!("{whole}h{minutes:02}")
    }
}

fn timeline_text(item: &Item) -> String {
    match item.kind {
        ItemKind::TimeEntry => {
            let hours = item
                .data_json
                .get("hours")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            format!("{} · {}", format_hours(hours), item.title)
        }
        _ => item.title.clone(),
    }
}

fn item_kind_name(kind: ItemKind) -> Result<String, RepoError> {
    Ok(serde_json::to_value(kind)?
        .as_str()
        .unwrap_or("item")
        .to_owned())
}

pub fn entity_card(conn: &Connection, id: &str) -> Result<EntityCard, RepoError> {
    entity_card_at(conn, id, SystemTime::now())
}

pub fn entity_card_at(
    conn: &Connection,
    id: &str,
    now: SystemTime,
) -> Result<EntityCard, RepoError> {
    let entity: Entity = require(conn, id)?;
    let entity_links: Vec<Link> = list_where(
        conn,
        "from_type = 'entity' AND to_type = 'entity' AND (from_id = ?1 OR to_id = ?1)",
        "rowid",
        vec![text(id)],
    )?;
    let mut links: Vec<LinkedEntity> = Vec::new();
    let mut project_ids: Vec<String> = Vec::new();
    let mut owned_project_ids: Vec<String> = Vec::new();
    for link in &entity_links {
        let outgoing = link.from_id == id;
        let other_id = if outgoing { &link.to_id } else { &link.from_id };
        let Some(other) = get::<Entity>(conn, other_id)? else {
            continue;
        };
        if other.kind == EntityKind::Project && entity.kind != EntityKind::Project {
            if !project_ids.contains(&other.id) {
                project_ids.push(other.id.clone());
            }
            if !outgoing && link.rel == "belongs_to" && !owned_project_ids.contains(&other.id) {
                owned_project_ids.push(other.id.clone());
            }
        }
        links.push(LinkedEntity {
            link_id: link.id.clone(),
            rel: link.rel.clone(),
            direction: if outgoing { "out" } else { "in" }.to_owned(),
            origin: link.origin.clone(),
            confidence: link.confidence,
            entity: other,
        });
    }
    let mut scope: Vec<String> = vec![id.to_owned()];
    scope.extend(owned_project_ids.iter().cloned());

    let facts = list_facts(conn, Some(id))?
        .into_iter()
        .map(|fact| {
            let source = source_of(conn, &fact)?;
            Ok(FactView { fact, source })
        })
        .collect::<Result<Vec<FactView>, RepoError>>()?;

    let mut projects: Vec<ProjectSummary> = Vec::new();
    for project_id in &project_ids {
        let project: Entity = require(conn, project_id)?;
        let hours_logged: f64 = conn.query_row(
            "SELECT COALESCE(SUM(json_extract(i.data_json, '$.hours')), 0) FROM items i
             JOIN links l ON l.from_type = 'item' AND l.from_id = i.id AND l.to_type = 'entity' AND l.to_id = ?1
             WHERE i.kind = 'time_entry'",
            [project_id],
            |row| row.get(0),
        )?;
        projects.push(ProjectSummary {
            entity: project,
            hours_logged,
        });
    }

    let placeholders = (1..=scope.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let scope_values: Vec<Value> = scope.iter().map(|value| text(value)).collect();

    let sql = format!(
        "SELECT f.id, f.source_id, f.rel_path, f.ext, f.size, f.mtime, f.sha256, f.role, f.status, f.indexed_at, l.rel, l.origin
         FROM links l JOIN files f ON f.id = l.from_id
         WHERE l.from_type = 'file' AND l.to_type = 'entity' AND l.to_id IN ({placeholders})
         ORDER BY f.mtime DESC"
    );
    let mut statement = conn.prepare(&sql)?;
    let file_rows = statement
        .query_map(params_from_iter(scope_values.clone()), |row| {
            Ok((
                FileEntry {
                    id: row.get(0)?,
                    source_id: row.get(1)?,
                    rel_path: row.get(2)?,
                    ext: row.get(3)?,
                    size: row.get(4)?,
                    mtime: row.get(5)?,
                    sha256: row.get(6)?,
                    role: row.get(7)?,
                    status: row.get(8)?,
                    indexed_at: row.get(9)?,
                },
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<(FileEntry, String, String)>>>()?;
    let mut documents: Vec<LinkedDocument> = Vec::new();
    let mut timeline: Vec<TimelineEntry> = Vec::new();
    let mut seen_files: HashSet<String> = HashSet::new();
    for (file, rel, origin) in file_rows {
        if !seen_files.insert(file.id.clone()) {
            continue;
        }
        timeline.push(TimelineEntry {
            id: file.id.clone(),
            kind: "file".to_owned(),
            at: Some(file.mtime.clone()),
            text: file.rel_path.clone(),
            item: None,
        });
        documents.push(LinkedDocument {
            file_id: file.id,
            name: file.rel_path,
            ext: file.ext,
            rel,
            origin,
        });
    }

    let items: Vec<Item> = list_where(
        conn,
        &format!(
            "id IN (SELECT from_id FROM links WHERE from_type = 'item' AND to_type = 'entity' AND to_id IN ({placeholders}))"
        ),
        "occurred_at DESC, rowid DESC",
        scope_values,
    )?;
    let stats = entity_stats(&items, now);
    let notes: Vec<EntityNote> = items
        .iter()
        .filter(|item| item.kind == ItemKind::Note)
        .take(NOTES_LIMIT)
        .map(|item| {
            let note_type = note_type_of(item);
            let source_id = (note_type.as_deref() == Some("minutes"))
                .then(|| {
                    item.external_id
                        .strip_prefix(super::minutes::EXTERNAL_ID_PREFIX)
                        .map(str::to_owned)
                })
                .flatten();
            // Un transcript ou un PV n'est jamais affiché en texte intégral : l'UI montre un lien vers son écran.
            let text = if matches!(note_type.as_deref(), Some("transcript" | "minutes")) {
                item.title.clone()
            } else {
                item.body_text
                    .clone()
                    .filter(|body| !body.trim().is_empty())
                    .unwrap_or_else(|| item.title.clone())
            };
            EntityNote {
                id: item.id.clone(),
                at: item
                    .occurred_at
                    .clone()
                    .or_else(|| Some(item.updated_at.clone())),
                text,
                note_type,
                source_id,
            }
        })
        .collect();
    for item in &items {
        timeline.push(TimelineEntry {
            id: item.id.clone(),
            kind: item_kind_name(item.kind)?,
            at: item
                .occurred_at
                .clone()
                .or_else(|| Some(item.updated_at.clone())),
            text: timeline_text(item),
            item: (item.kind == ItemKind::Event).then(|| item.clone()),
        });
    }
    timeline.sort_by(|left, right| right.at.cmp(&left.at));
    timeline.truncate(TIMELINE_LIMIT);

    let active_jobs: Vec<Job> = list_where(
        conn,
        "status IN ('queued', 'running', 'waiting_approval') AND id IN (SELECT from_id FROM links WHERE from_type = 'job' AND to_type = 'entity' AND to_id = ?1)",
        "created_at DESC",
        vec![text(id)],
    )?;

    let synthesis = get_synthesis(conn, id)?;

    Ok(EntityCard {
        entity,
        synthesis,
        stats,
        notes,
        facts,
        projects,
        documents,
        timeline,
        links,
        active_jobs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::testing::test_db;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn normalize_tags_trims_dedupes_and_drops_empty() {
        assert_eq!(
            normalize_tags(&strings(&[
                " #Maintenance ",
                "maintenance",
                "",
                "  ",
                "Vision   3D"
            ])),
            strings(&["Maintenance", "Vision 3D"])
        );
    }

    #[test]
    fn normalize_tags_caps_length_and_count() {
        let long = "x".repeat(TAG_MAX_CHARS + 10);
        assert_eq!(normalize_tags(&[long])[0].chars().count(), TAG_MAX_CHARS);
        let many: Vec<String> = (0..TAGS_MAX + 5)
            .map(|index| format!("tag{index}"))
            .collect();
        assert_eq!(normalize_tags(&many).len(), TAGS_MAX);
    }

    #[test]
    fn update_entity_changes_kind_and_tags_only_when_given() {
        let db = test_db("update-entity");
        let saved = db
            .with_conn(|conn| Ok(entity(conn, EntityKind::Contact, "Fiduciaire")))
            .expect("entity");
        let reclassified = db
            .with_conn(|conn| {
                update_entity(
                    conn,
                    &saved.id,
                    EntityUpdate {
                        kind: Some(EntityKind::Other),
                        tags: None,
                    },
                )
            })
            .expect("kind");
        assert_eq!(reclassified.kind, EntityKind::Other);
        assert_eq!(reclassified.tags_json, json!([]));
        let tagged = db
            .with_conn(|conn| {
                update_entity(
                    conn,
                    &saved.id,
                    EntityUpdate {
                        kind: None,
                        tags: Some(strings(&["compta", "#Compta", "annuel"])),
                    },
                )
            })
            .expect("tags");
        assert_eq!(tagged.kind, EntityKind::Other);
        assert_eq!(tagged.tags_json, json!(["compta", "annuel"]));
        let reloaded: Entity = db
            .with_conn(|conn| require(conn, &saved.id))
            .expect("reload");
        assert_eq!(reloaded.tags_json, tagged.tags_json);
    }
    use crate::files::embed::{vector_to_blob, EMBEDDING_DIMENSION};

    fn entity(conn: &Connection, kind: EntityKind, name: &str) -> Entity {
        save_entity(
            conn,
            EntitySave {
                id: None,
                kind,
                name: name.to_owned(),
                tags_json: json!([]),
                data_json: json!({}),
            },
        )
        .expect("save entity")
    }

    fn link(conn: &Connection, from_type: &str, from_id: &str, to: &str, rel: &str) {
        insert_links_if_absent(
            conn,
            &[LinkProposalRow {
                from_type: from_type.to_owned(),
                from_id: from_id.to_owned(),
                to_entity_id: to.to_owned(),
                rel: rel.to_owned(),
                confidence: Some(0.9),
            }],
            "auto",
        )
        .expect("insert link");
    }

    fn file(conn: &Connection, id: &str, rel_path: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO file_sources (id, kind, path, watch_mode) VALUES ('s1', 'local', 'src', 'poll')",
            [],
        )
        .expect("source");
        conn.execute(
            "INSERT INTO files (id, source_id, rel_path, ext, size, mtime, role, status)
             VALUES (?1, 's1', ?2, 'pdf', 10, '2026-02-01T00:00:00.000Z', 'reference', 'indexed')",
            params![id, rel_path],
        )
        .expect("file");
    }

    fn basis_vector(axis: usize, tilt: f32) -> Vec<f32> {
        let mut vector = vec![0.0_f32; EMBEDDING_DIMENSION];
        vector[axis] = 1.0;
        vector[axis + 1] = tilt;
        vector
    }

    fn chunk(
        conn: &Connection,
        file_id: &str,
        ord: i64,
        body: &str,
        vector: Option<&[f32]>,
    ) -> i64 {
        conn.execute(
            "INSERT INTO chunks (owner_type, owner_id, ord, text) VALUES ('file', ?1, ?2, ?3)",
            params![file_id, ord, body],
        )
        .expect("chunk");
        let chunk_id = conn.last_insert_rowid();
        if let Some(vector) = vector {
            conn.execute(
                "INSERT INTO chunks_vec (rowid, embedding) VALUES (?1, ?2)",
                params![chunk_id, vector_to_blob(vector)],
            )
            .expect("vector");
        }
        chunk_id
    }

    #[test]
    fn auto_links_never_override_a_user_link() {
        let db = test_db("brain-links");
        db.with_conn(|conn| {
            let client = entity(conn, EntityKind::Client, "Atelier");
            file(conn, "f1", "offre.pdf");
            conn.execute(
                "INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, confidence, created_at)
                 VALUES ('l1', 'file', 'f1', 'entity', ?1, 'about', 'user', NULL, '2026-01-01T00:00:00.000Z')",
                [&client.id],
            )?;
            let inserted = insert_links_if_absent(
                conn,
                &[LinkProposalRow {
                    from_type: "file".to_owned(),
                    from_id: "f1".to_owned(),
                    to_entity_id: client.id.clone(),
                    rel: "about".to_owned(),
                    confidence: Some(0.7),
                }],
                "auto",
            )?;
            let origin: String =
                conn.query_row("SELECT origin FROM links WHERE id = 'l1'", [], |row| row.get(0))?;
            assert_eq!(inserted, 0);
            assert_eq!(origin, "user");
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn rejecting_a_fact_deletes_it_and_confirming_updates_the_status() {
        let db = test_db("brain-facts");
        db.with_conn(|conn| {
            let client = entity(conn, EntityKind::Client, "Atelier");
            let fact = add_fact(
                conn,
                NewFact {
                    entity_id: client.id.clone(),
                    text: "Paie a 45 jours".to_owned(),
                    source_type: "item".to_owned(),
                    source_id: "gone".to_owned(),
                    status: FactStatus::Inferred,
                },
            )?;
            let confirmed = decide_fact(conn, &fact.id, FactDecision::Confirmed)?;
            assert_eq!(
                confirmed.map(|fact| fact.status),
                Some(FactStatus::Confirmed)
            );
            assert_eq!(list_facts(conn, Some(&client.id))?.len(), 1);
            assert!(decide_fact(conn, &fact.id, FactDecision::Rejected)?.is_none());
            assert!(list_facts(conn, Some(&client.id))?.is_empty());
            assert!(decide_fact(conn, &fact.id, FactDecision::Rejected).is_err());
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn a_note_becomes_an_item_of_the_single_brain_connector_linked_to_the_entity() {
        let db = test_db("brain-note");
        db.with_conn(|conn| {
            let client = entity(conn, EntityKind::Client, "Atelier");
            let first = add_entity_note(conn, &client.id, "Prefers signed PDF\nsecond line")?;
            let second = add_entity_note(conn, &client.id, "Another note")?;
            let connectors: Vec<Connector> = list(conn)?;
            let brain: Vec<&Connector> = connectors
                .iter()
                .filter(|connector| connector.kind == BRAIN_CONNECTOR_KIND)
                .collect();
            assert_eq!(brain.len(), 1);
            assert_eq!(first.kind, ItemKind::Note);
            assert_eq!(first.connector_id, brain[0].id);
            assert_eq!(first.title, "Prefers signed PDF");
            assert_ne!(first.id, second.id);
            let origin: String = conn.query_row(
                "SELECT origin FROM links WHERE from_type = 'item' AND from_id = ?1 AND to_id = ?2",
                params![first.id, client.id],
                |row| row.get(0),
            )?;
            assert_eq!(origin, "user");
            assert!(add_entity_note(conn, &client.id, "  ").is_err());
            Ok(())
        })
        .expect("repo calls");
    }

    fn stats_item(kind: ItemKind, occurred_at: &str, hours: Option<f64>) -> Item {
        Item {
            id: new_id(),
            connector_id: "c".to_owned(),
            kind,
            external_id: new_id(),
            title: "t".to_owned(),
            body_text: None,
            occurred_at: Some(occurred_at.to_owned()),
            data_json: hours.map_or_else(|| json!({}), |hours| json!({ "hours": hours })),
            updated_at: occurred_at.to_owned(),
        }
    }

    #[test]
    fn entity_stats_sum_recent_hours_and_keep_the_last_past_message() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(100 * 86_400);
        let items = vec![
            stats_item(ItemKind::TimeEntry, "1970-04-01T08:00:00.000Z", Some(2.5)),
            stats_item(ItemKind::TimeEntry, "1970-03-20T08:00:00.000Z", Some(1.0)),
            stats_item(ItemKind::TimeEntry, "1970-02-01T08:00:00.000Z", Some(9.0)),
            stats_item(ItemKind::Message, "1970-04-05T08:00:00.000Z", None),
            stats_item(ItemKind::Message, "1970-03-01T08:00:00.000Z", None),
            stats_item(ItemKind::Message, "1970-06-01T08:00:00.000Z", None),
            stats_item(ItemKind::Event, "1970-04-09T08:00:00.000Z", None),
        ];
        let stats = entity_stats(&items, now);
        assert!((stats.hours_last_30_days - 3.5).abs() < f64::EPSILON);
        assert_eq!(
            stats.last_message_at.as_deref(),
            Some("1970-04-05T08:00:00.000Z")
        );
    }

    #[test]
    fn entity_card_carries_the_saved_synthesis_and_full_notes() {
        let db = test_db("brain-synthesis");
        db.with_conn(|conn| {
            let client = entity(conn, EntityKind::Client, "Atelier");
            add_entity_note(conn, &client.id, "Prefers signed PDF\nsecond line")?;
            assert!(entity_card(conn, &client.id)?.synthesis.is_none());
            assert!(save_synthesis(
                conn,
                SynthesisSave {
                    entity_id: client.id.clone(),
                    text: "  ".to_owned(),
                    source_count: 0,
                    signature: "s".to_owned(),
                    job_id: None,
                },
            )
            .is_err());
            save_synthesis(
                conn,
                SynthesisSave {
                    entity_id: client.id.clone(),
                    text: " Client historique. ".to_owned(),
                    source_count: 3,
                    signature: "sig-1".to_owned(),
                    job_id: None,
                },
            )?;
            let card = entity_card(conn, &client.id)?;
            let synthesis = card.synthesis.expect("synthesis");
            assert_eq!(synthesis.text, "Client historique.");
            assert_eq!(synthesis.source_count, 3);
            assert_eq!(list_syntheses(conn)?.len(), 1);
            assert_eq!(card.notes.len(), 1);
            assert_eq!(card.notes[0].text, "Prefers signed PDF\nsecond line");
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn entity_card_lists_linked_projects_whatever_the_entity_kind() {
        let db = test_db("brain-card-projects");
        db.with_conn(|conn| {
            let owner = entity(conn, EntityKind::Other, "Fiduciaire");
            let owned = entity(conn, EntityKind::Project, "Bouclement");
            let related = entity(conn, EntityKind::Project, "Audit");
            link(conn, "entity", &owned.id, &owner.id, "belongs_to");
            link(conn, "entity", &owner.id, &related.id, "related");
            let card = entity_card(conn, &owner.id)?;
            let names: Vec<&str> = card
                .projects
                .iter()
                .map(|project| project.entity.name.as_str())
                .collect();
            assert_eq!(names, vec!["Bouclement", "Audit"]);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn entity_card_gathers_projects_hours_documents_and_a_unified_timeline() {
        let db = test_db("brain-card");
        db.with_conn(|conn| {
            let client = entity(conn, EntityKind::Client, "Atelier Rhone SA");
            let project = entity(conn, EntityKind::Project, "Ligne 3");
            link(conn, "entity", &project.id, &client.id, "belongs_to");
            file(conn, "f1", "cahier.pdf");
            link(conn, "file", "f1", &project.id, "about");
            let connector = ensure_brain_connector(conn)?;
            let rows = [
                (
                    ItemKind::TimeEntry,
                    "t1",
                    "Cablage",
                    json!({ "hours": 3.5 }),
                    "2026-03-02T10:00:00.000Z",
                ),
                (
                    ItemKind::Message,
                    "m1",
                    "Re: Offre",
                    json!({}),
                    "2026-03-01T10:00:00.000Z",
                ),
            ];
            for (kind, external_id, title, data_json, occurred_at) in rows {
                upsert_items(
                    conn,
                    &[ItemUpsert {
                        connector_id: connector.id.clone(),
                        kind,
                        external_id: external_id.to_owned(),
                        title: title.to_owned(),
                        body_text: None,
                        occurred_at: Some(occurred_at.to_owned()),
                        data_json,
                        updated_at: occurred_at.to_owned(),
                    }],
                )?;
            }
            let items: Vec<Item> = list(conn)?;
            let message = items
                .iter()
                .find(|item| item.kind == ItemKind::Message)
                .expect("message");
            for item in &items {
                let target = if item.kind == ItemKind::TimeEntry {
                    &project.id
                } else {
                    &client.id
                };
                link(conn, "item", &item.id, target, "about");
            }
            let fact = add_fact(
                conn,
                NewFact {
                    entity_id: client.id.clone(),
                    text: "Prefers PDF".to_owned(),
                    source_type: "item".to_owned(),
                    source_id: message.id.clone(),
                    status: FactStatus::Inferred,
                },
            )?;

            let card = entity_card(conn, &client.id)?;

            assert_eq!(card.projects.len(), 1);
            assert!((card.projects[0].hours_logged - 3.5).abs() < f64::EPSILON);
            assert_eq!(card.documents.len(), 1);
            assert_eq!(card.documents[0].name, "cahier.pdf");
            let kinds: Vec<&str> = card
                .timeline
                .iter()
                .map(|entry| entry.kind.as_str())
                .collect();
            assert_eq!(kinds, ["time_entry", "message", "file"]);
            assert_eq!(card.timeline[0].text, "3h30 · Cablage");
            assert_eq!(card.facts[0].fact.id, fact.id);
            assert_eq!(card.facts[0].source.label, "Re: Offre");
            assert_eq!(card.links.len(), 1);
            assert_eq!(card.links[0].direction, "in");
            assert!(card.active_jobs.is_empty());
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn summaries_filter_by_kind_and_name() {
        let db = test_db("brain-summaries");
        db.with_conn(|conn| {
            let client = entity(conn, EntityKind::Client, "Atelier Rhone SA");
            let project = entity(conn, EntityKind::Project, "Ligne 3");
            entity(conn, EntityKind::Contact, "M. Keller");
            link(conn, "entity", &project.id, &client.id, "belongs_to");

            let clients = list_entity_summaries(conn, Some(EntityKind::Client), None)?;
            let by_name = list_entity_summaries(conn, None, Some("keller"))?;

            assert_eq!(clients.len(), 1);
            assert_eq!(clients[0].meta, "1 projet");
            assert_eq!(by_name.len(), 1);
            assert_eq!(by_name[0].entity.name, "M. Keller");
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn grouped_search_finds_entities_by_prefix_and_splits_documents_from_mails() {
        let db = test_db("brain-search");
        db.with_conn(|conn| {
            let atelier = entity(conn, EntityKind::Client, "Atelier Rhone SA");
            entity(conn, EntityKind::Client, "Laiterie");
            file(conn, "f1", "atelier-offre.pdf");
            link(conn, "file", "f1", &atelier.id, "about");
            let chunk_id = chunk(conn, "f1", 0, "offre atelier", None);
            let connector = ensure_brain_connector(conn)?;
            upsert_items(
                conn,
                &[ItemUpsert {
                    connector_id: connector.id,
                    kind: ItemKind::Message,
                    external_id: "m1".to_owned(),
                    title: "Atelier: visite".to_owned(),
                    body_text: Some("rdv".to_owned()),
                    occurred_at: None,
                    data_json: json!({}),
                    updated_at: "2026-03-01T10:00:00.000Z".to_owned(),
                }],
            )?;
            let hits = [SearchHit {
                chunk_id,
                owner_type: "file".to_owned(),
                owner_id: "f1".to_owned(),
                text: "offre atelier".to_owned(),
                score: 1.0,
            }];

            let result = group_search(conn, "Atelier", &hits)?;

            assert_eq!(result.entities.len(), 1);
            assert_eq!(result.entities[0].name, "Atelier Rhone SA");
            assert_eq!(result.documents.len(), 1);
            assert_eq!(
                result.documents[0].entity_id.as_deref(),
                Some(atelier.id.as_str())
            );
            assert_eq!(result.mails.len(), 1);
            assert!(result.mails[0].entity_id.is_none());
            assert_eq!(result.mails[0].title, "Atelier: visite");
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn chunk_neighbors_rank_files_by_vector_proximity_and_skip_the_file_itself() {
        let db = test_db("brain-neighbors");
        db.with_conn(|conn| {
            for (id, name) in [("new", "new.pdf"), ("near", "near.pdf"), ("far", "far.pdf")] {
                file(conn, id, name);
            }
            chunk(conn, "new", 0, "new", Some(&basis_vector(0, 0.0)));
            chunk(conn, "near", 0, "near", Some(&basis_vector(0, 0.1)));
            chunk(conn, "far", 0, "far", Some(&basis_vector(10, 0.0)));

            let neighbors = chunk_neighbors(conn, "new")?;

            let owners: Vec<&str> = neighbors.iter().map(|n| n.owner_id.as_str()).collect();
            assert_eq!(owners, ["near", "far"]);
            assert!(neighbors[0].distance < neighbors[1].distance);
            Ok(())
        })
        .expect("repo calls");
    }
}
