use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub file_id: String,
    pub name: String,
    pub instructions: String,
    #[ts(type = "unknown")]
    pub variables_json: serde_json::Value,
    #[ts(type = "number")]
    pub version: i64,
}
