use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[ts(type = "number")]
    pub chunk_id: i64,
    pub owner_type: String,
    pub owner_id: String,
    pub text: String,
    pub score: f64,
}
