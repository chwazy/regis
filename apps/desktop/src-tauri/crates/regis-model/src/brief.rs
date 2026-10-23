use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub id: String,
    pub date: String,
    pub generated_at: String,
    pub job_id: Option<String>,
    pub headline: String,
    #[ts(type = "unknown")]
    pub sections_json: serde_json::Value,
}
