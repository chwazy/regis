use serde_json::json;

use crate::db::Db;
use regis_model::{Agent, AgentMode, AgentRuntime, Connector};

pub fn test_db(name: &str) -> Db {
    let dir = std::env::temp_dir().join(format!("regis-repo-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    Db::open(&dir.join("regis.sqlite")).expect("open db")
}

pub fn sample_connector(id: &str) -> Connector {
    Connector {
        id: id.to_owned(),
        kind: "m365".to_owned(),
        name: "Microsoft 365".to_owned(),
        transport: "stdio".to_owned(),
        command: Some("npx".to_owned()),
        args_json: json!([]),
        url: None,
        env_json: json!({}),
        secret_ref: None,
        enabled: true,
        sync_json: json!({}),
        status: "unknown".to_owned(),
        last_sync_at: None,
        created_at: "2026-01-01T00:00:00.000Z".to_owned(),
    }
}

pub fn sample_agent(id: &str) -> Agent {
    Agent {
        id: id.to_owned(),
        name: format!("agent-{id}"),
        runtime: AgentRuntime::Ollama,
        mode: AgentMode::Api,
        account_label: None,
        model: None,
        budget_daily_usd: None,
        use_when: String::new(),
        can_spawn: false,
        worktree_per_job: false,
        connector_ids_json: json!([]),
        secret_ref: None,
        is_local_only: true,
        enabled: true,
    }
}
