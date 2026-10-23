use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub runtime: AgentRuntime,
    pub mode: AgentMode,
    pub account_label: Option<String>,
    pub model: Option<String>,
    pub budget_daily_usd: Option<f64>,
    pub use_when: String,
    pub can_spawn: bool,
    pub worktree_per_job: bool,
    #[ts(type = "unknown")]
    pub connector_ids_json: serde_json::Value,
    pub secret_ref: Option<String>,
    pub is_local_only: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "kebab-case")]
pub enum AgentRuntime {
    ClaudeCli,
    AnthropicApi,
    Ollama,
    CodexCli,
    GeminiCli,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    Headless,
    Pty,
    Acp,
    Api,
}
