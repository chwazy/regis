use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRule {
    pub id: String,
    #[ts(type = "number")]
    pub ord: i64,
    #[ts(type = "unknown")]
    pub conditions_json: serde_json::Value,
    pub agent_id: String,
    pub reason: String,
    pub enabled: bool,
}
