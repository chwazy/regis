use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub entity_id: String,
    pub text: String,
    pub source_type: String,
    pub source_id: String,
    pub status: FactStatus,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum FactStatus {
    Confirmed,
    ToVerify,
    Inferred,
}
