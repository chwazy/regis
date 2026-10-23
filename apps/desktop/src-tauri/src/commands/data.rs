use serde_json::{json, Value};
use tauri::State;

use crate::AppState;
use regis_core::db::repo::{self, JobFilter, RepoError};
use regis_core::secrets;
use regis_model::{
    Agent, Approval, ApprovalStatus, Connector, Job, JobEvent, JobStatus, RoutingRule, ToolPolicy,
};

fn run<T>(
    state: &State<'_, AppState>,
    operation: impl FnOnce(&mut rusqlite::Connection) -> Result<T, RepoError>,
) -> Result<T, String> {
    state
        .db
        .with_conn(operation)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_jobs(
    state: State<'_, AppState>,
    status: Option<JobStatus>,
    limit: Option<i64>,
) -> Result<Vec<Job>, String> {
    run(&state, |conn| {
        repo::list_jobs(conn, &JobFilter { status, limit })
    })
}

#[tauri::command]
pub async fn get_job(state: State<'_, AppState>, id: String) -> Result<Job, String> {
    run(&state, |conn| repo::require(conn, &id))
}

#[tauri::command]
pub async fn list_job_events(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Vec<JobEvent>, String> {
    run(&state, |conn| repo::list_job_events(conn, &job_id))
}

#[tauri::command]
pub async fn list_approvals(
    state: State<'_, AppState>,
    status: Option<ApprovalStatus>,
) -> Result<Vec<Approval>, String> {
    run(&state, |conn| repo::list_approvals(conn, status))
}

#[tauri::command]
pub async fn resolve_approval(
    state: State<'_, AppState>,
    id: String,
    status: ApprovalStatus,
    decision_note: Option<String>,
    edited_input: Option<Value>,
) -> Result<Approval, String> {
    let decision = approval_decision(status, &decision_note, &edited_input);
    let approval = run(&state, |conn| {
        repo::resolve_approval(conn, &id, status, decision_note, edited_input)
    })?;
    state.bus.emit("approval.resolved", &approval);
    state
        .sidecar
        .call::<Value>(
            "approvals.resolve",
            json!({ "approvalId": approval.id, "decision": decision }),
        )
        .await
        .map_err(|error| {
            format!("approval recorded but the agent could not be notified: {error}")
        })?;
    Ok(approval)
}

fn approval_decision(
    status: ApprovalStatus,
    note: &Option<String>,
    edited_input: &Option<Value>,
) -> Value {
    let mut decision = json!({ "status": status });
    if let Some(note) = note {
        decision["note"] = json!(note);
    }
    if let Some(input) = edited_input {
        decision["updatedInput"] = input.clone();
    }
    decision
}

#[tauri::command]
pub async fn list_agents(state: State<'_, AppState>) -> Result<Vec<Agent>, String> {
    run(&state, |conn| repo::list(conn))
}

#[tauri::command]
pub async fn save_agent(state: State<'_, AppState>, agent: Agent) -> Result<Agent, String> {
    run(&state, |conn| repo::save_agent(conn, agent))
}

#[tauri::command]
pub async fn delete_agent(state: State<'_, AppState>, id: String) -> Result<(), String> {
    run(&state, |conn| repo::delete::<Agent>(conn, &id)).map(|_| ())
}

#[tauri::command]
pub async fn list_connectors(state: State<'_, AppState>) -> Result<Vec<Connector>, String> {
    run(&state, |conn| repo::list(conn))
}

#[tauri::command]
pub async fn save_connector(
    state: State<'_, AppState>,
    connector: Connector,
) -> Result<Connector, String> {
    run(&state, |conn| repo::save_connector(conn, connector))
}

#[tauri::command]
pub async fn delete_connector(state: State<'_, AppState>, id: String) -> Result<(), String> {
    run(&state, |conn| repo::delete::<Connector>(conn, &id)).map(|_| ())
}

#[tauri::command]
pub async fn list_policies(state: State<'_, AppState>) -> Result<Vec<ToolPolicy>, String> {
    run(&state, |conn| repo::list(conn))
}

#[tauri::command]
pub async fn save_policy(
    state: State<'_, AppState>,
    policy: ToolPolicy,
) -> Result<ToolPolicy, String> {
    run(&state, |conn| repo::save_policy(conn, policy))
}

#[tauri::command]
pub async fn list_rules(state: State<'_, AppState>) -> Result<Vec<RoutingRule>, String> {
    run(&state, |conn| repo::list_rules(conn))
}

#[tauri::command]
pub async fn save_rules(
    state: State<'_, AppState>,
    rules: Vec<RoutingRule>,
) -> Result<Vec<RoutingRule>, String> {
    run(&state, |conn| repo::save_rules(conn, rules))
}

#[tauri::command]
pub async fn set_secret(secret_ref: String, value: String) -> Result<(), String> {
    secrets::set_secret(&secret_ref, &value).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_secret(secret_ref: String) -> Result<(), String> {
    secrets::delete_secret(&secret_ref).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    run(&state, |conn| repo::get_setting(conn, &key))
}

#[tauri::command]
pub async fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    validate_setting(&key, &value)?;
    run(&state, |conn| repo::set_setting(conn, &key, &value))?;
    state.bus.emit("settings.changed", &json!({ "key": key }));
    Ok(())
}

const DEFAULT_WRITE_KEY: &str = "policy.defaultWrite";

fn validate_setting(key: &str, value: &str) -> Result<(), String> {
    if key == DEFAULT_WRITE_KEY {
        match value {
            "ask" | "deny" => {}
            "auto" => return Err("Une écriture ne peut pas être automatique par défaut".to_owned()),
            other => {
                return Err(format!(
                    "Valeur invalide pour {DEFAULT_WRITE_KEY} : {other}"
                ))
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_write_accepts_only_ask_and_deny() {
        assert!(validate_setting(DEFAULT_WRITE_KEY, "ask").is_ok());
        assert!(validate_setting(DEFAULT_WRITE_KEY, "deny").is_ok());
        let error = validate_setting(DEFAULT_WRITE_KEY, "auto").unwrap_err();
        assert!(error.contains("automatique"));
        assert!(validate_setting(DEFAULT_WRITE_KEY, "x").is_err());
        assert!(validate_setting("app.timezone", "auto").is_ok());
    }

    #[test]
    fn approval_decision_carries_status_note_and_edited_input() {
        let decision = approval_decision(
            ApprovalStatus::Edited,
            &Some("fix the subject".to_owned()),
            &Some(json!({ "subject": "Re: offer" })),
        );

        assert_eq!(
            decision,
            json!({
                "status": "edited",
                "note": "fix the subject",
                "updatedInput": { "subject": "Re: offer" }
            })
        );
    }

    #[test]
    fn approval_decision_omits_absent_fields() {
        let decision = approval_decision(ApprovalStatus::Approved, &None, &None);

        assert_eq!(decision, json!({ "status": "approved" }));
    }
}
