use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub job_id: String,
    pub tool: String,
    #[ts(type = "unknown")]
    pub input_json: serde_json::Value,
    #[ts(type = "unknown")]
    pub preview_json: serde_json::Value,
    pub status: ApprovalStatus,
    pub decision_note: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NewApproval {
    pub job_id: String,
    pub tool: String,
    #[ts(type = "unknown")]
    pub input_json: serde_json::Value,
    #[serde(default = "empty_object")]
    #[ts(type = "unknown", optional)]
    pub preview_json: serde_json::Value,
    pub decision_note: Option<String>,
    pub decided_at: Option<String>,
}

fn empty_object() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
    Edited,
}
