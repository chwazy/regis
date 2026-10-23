use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub parent_id: Option<String>,
    pub agent_id: String,
    pub kind: String,
    pub title: String,
    pub prompt: String,
    pub status: JobStatus,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub cost_usd: f64,
    #[ts(type = "number")]
    pub tokens_in: i64,
    #[ts(type = "number")]
    pub tokens_out: i64,
    pub routing_reason: Option<String>,
    pub result_text: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NewJob {
    pub parent_id: Option<String>,
    pub agent_id: String,
    pub kind: String,
    pub title: String,
    pub prompt: String,
    pub status: JobStatus,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub routing_reason: Option<String>,
    pub result_text: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    WaitingApproval,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    #[ts(type = "number")]
    pub id: i64,
    pub job_id: String,
    #[ts(type = "number")]
    pub seq: i64,
    pub at: String,
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub event_type: JobEventType,
    pub summary: String,
    #[ts(type = "unknown")]
    pub payload_json: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NewJobEvent {
    pub job_id: String,
    pub at: String,
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub event_type: JobEventType,
    pub summary: String,
    #[serde(default = "empty_object")]
    #[ts(type = "unknown", optional)]
    pub payload_json: serde_json::Value,
}

fn empty_object() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum JobEventType {
    Start,
    Message,
    ToolCall,
    ToolResult,
    File,
    ApprovalRequest,
    ApprovalResolved,
    End,
    Error,
}
