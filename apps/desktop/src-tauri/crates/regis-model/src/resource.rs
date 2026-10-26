use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EntityResource {
    pub id: String,
    pub entity_id: String,
    pub kind: ResourceKind,
    pub label: Option<String>,
    pub value: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Repo,
    Remote,
    Conventions,
    Specs,
    Document,
    Link,
}
