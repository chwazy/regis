use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Entity, EntityResource, Fact, Item, Job};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FactSource {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub file_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FactView {
    pub fact: Fact,
    pub source: FactSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub entity: Entity,
    pub hours_logged: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinkedDocument {
    pub file_id: String,
    pub name: String,
    pub ext: String,
    pub rel: String,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub id: String,
    pub kind: String,
    pub at: Option<String>,
    pub text: String,
    /// Renseigné pour les événements uniquement (bouton « Rejoindre » de l'historique).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub item: Option<Item>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinkedEntity {
    pub link_id: String,
    pub rel: String,
    pub direction: String,
    pub origin: String,
    pub confidence: Option<f64>,
    pub entity: Entity,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EntitySynthesis {
    pub entity_id: String,
    pub text: String,
    #[ts(type = "number")]
    pub source_count: i64,
    pub signature: String,
    pub job_id: Option<String>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EntityStats {
    pub hours_last_30_days: f64,
    pub last_message_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EntityNote {
    pub id: String,
    pub at: Option<String>,
    pub text: String,
    /// 'transcript' | 'minutes' | None pour une note libre. Pour un transcript, `text` est le titre.
    pub note_type: Option<String>,
    /// Pour un PV (`minutes`), id de la note transcript dont il est tiré ; `None` sinon.
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EntityCard {
    pub entity: Entity,
    pub synthesis: Option<EntitySynthesis>,
    pub stats: EntityStats,
    pub notes: Vec<EntityNote>,
    pub facts: Vec<FactView>,
    pub resources: Vec<EntityResource>,
    pub projects: Vec<ProjectSummary>,
    pub documents: Vec<LinkedDocument>,
    pub timeline: Vec<TimelineEntry>,
    pub links: Vec<LinkedEntity>,
    pub active_jobs: Vec<Job>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EntitySummary {
    pub entity: Entity,
    pub meta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DocumentHit {
    pub file_id: String,
    pub name: String,
    pub snippet: String,
    pub entity_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MailHit {
    pub item_id: String,
    pub title: String,
    pub snippet: String,
    pub entity_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NoteHit {
    pub item_id: String,
    pub title: String,
    pub note_type: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchResult {
    pub entities: Vec<Entity>,
    pub documents: Vec<DocumentHit>,
    pub mails: Vec<MailHit>,
    pub notes: Vec<NoteHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinkProposalRow {
    pub from_type: String,
    pub from_id: String,
    pub to_entity_id: String,
    pub rel: String,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChunkNeighbor {
    pub owner_id: String,
    pub distance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChunkText {
    #[ts(type = "number")]
    pub id: i64,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum FactDecision {
    Confirmed,
    ToVerify,
    Inferred,
    Rejected,
}
