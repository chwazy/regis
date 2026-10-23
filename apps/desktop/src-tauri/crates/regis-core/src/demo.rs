use serde_json::json;

use crate::db::repo::{self, RepoError};
use crate::db::Db;
use crate::events::now_iso_utc;
use regis_model::{Agent, AgentRuntime, Connector};

const DEMO_ENV: &str = "REGIS_DEMO";
const DEMO_SEED_KEY: &str = "seed.demo";
const BRAIN_EXTRACTIONS_KEY: &str = "brain.maxExtractionsPerDay";
const APPROVAL_WAIT_KEY: &str = "approvals.waitTimeoutSec";
const DEMO_APPROVAL_WAIT_SECS: &str = "86400";
const DEMO_SOURCES: &[(&str, &str)] = &[("m365", "Microsoft 365 (démo)"), ("odoo", "Odoo (démo)")];

pub fn is_enabled() -> bool {
    is_flag_set(std::env::var(DEMO_ENV).ok().as_deref())
}

fn is_flag_set(value: Option<&str>) -> bool {
    value == Some("1")
}

pub fn seed(db: &Db) -> Result<(), RepoError> {
    db.with_conn(|conn| {
        if repo::get_setting(conn, DEMO_SEED_KEY)?.is_some() {
            return Ok(());
        }
        let agents: Vec<Agent> = repo::list(conn)?;
        for agent in agents {
            repo::save_agent(conn, demo_agent(agent))?;
        }
        let synced_at = now_iso_utc();
        for (kind, name) in DEMO_SOURCES {
            let connector = repo::save_connector(conn, demo_connector(kind, name))?;
            repo::record_connector_sync(conn, &connector.id, "ok", Some(&synced_at))?;
        }
        repo::set_setting(conn, BRAIN_EXTRACTIONS_KEY, "0")?;
        repo::set_setting(conn, APPROVAL_WAIT_KEY, DEMO_APPROVAL_WAIT_SECS)?;
        repo::set_setting(conn, DEMO_SEED_KEY, "done")
    })
}

fn demo_agent(agent: Agent) -> Agent {
    let simulated = agent.runtime == AgentRuntime::ClaudeCli;
    Agent {
        enabled: simulated,
        worktree_per_job: false,
        account_label: simulated
            .then(|| "Simulé (mode démo)".to_owned())
            .or(agent.account_label.clone()),
        ..agent
    }
}

fn demo_connector(kind: &str, name: &str) -> Connector {
    Connector {
        id: String::new(),
        kind: kind.to_owned(),
        name: name.to_owned(),
        transport: "stdio".to_owned(),
        command: None,
        args_json: json!([]),
        url: None,
        env_json: json!({}),
        secret_ref: None,
        enabled: false,
        sync_json: json!({}),
        status: "unknown".to_owned(),
        last_sync_at: None,
        created_at: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_flag_enables_demo_mode() {
        assert!(is_flag_set(Some("1")));
        assert!(!is_flag_set(Some("0")));
        assert!(!is_flag_set(Some("true")));
        assert!(!is_flag_set(None));
    }
}
