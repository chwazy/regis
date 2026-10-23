use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub connector_id: String,
    pub kind: ItemKind,
    pub external_id: String,
    pub title: String,
    pub body_text: Option<String>,
    pub occurred_at: Option<String>,
    #[ts(type = "unknown")]
    pub data_json: serde_json::Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ItemUpsert {
    pub connector_id: String,
    pub kind: ItemKind,
    pub external_id: String,
    pub title: String,
    pub body_text: Option<String>,
    pub occurred_at: Option<String>,
    #[serde(default = "empty_object")]
    #[ts(type = "unknown", optional)]
    pub data_json: serde_json::Value,
    pub updated_at: String,
}

fn empty_object() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Message,
    Event,
    Task,
    TimeEntry,
    Invoice,
    Contact,
    Project,
    Partner,
    Note,
}
