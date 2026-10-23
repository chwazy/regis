use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    #[ts(type = "unknown")]
    pub args_json: serde_json::Value,
    pub url: Option<String>,
    #[ts(type = "unknown")]
    pub env_json: serde_json::Value,
    pub secret_ref: Option<String>,
    pub enabled: bool,
    #[ts(type = "unknown")]
    pub sync_json: serde_json::Value,
    pub status: String,
    pub last_sync_at: Option<String>,
    pub created_at: String,
}
