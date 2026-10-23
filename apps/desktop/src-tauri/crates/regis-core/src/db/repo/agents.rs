use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{
    column_enum, column_json, delete, enum_text, flag, json_text, list, new_id, opt_real, opt_text,
    text, upsert, Record, RepoError,
};
use regis_model::{Agent, AgentRuntime, RoutingRule, ToolPolicy};

impl Record for Agent {
    const TABLE: &'static str = "agents";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "name",
        "runtime",
        "mode",
        "account_label",
        "model",
        "budget_daily_usd",
        "use_when",
        "can_spawn",
        "worktree_per_job",
        "connector_ids_json",
        "secret_ref",
        "is_local_only",
        "enabled",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Agent {
            id: row.get("id")?,
            name: row.get("name")?,
            runtime: column_enum(row, "runtime")?,
            mode: column_enum(row, "mode")?,
            account_label: row.get("account_label")?,
            model: row.get("model")?,
            budget_daily_usd: row.get("budget_daily_usd")?,
            use_when: row.get("use_when")?,
            can_spawn: row.get("can_spawn")?,
            worktree_per_job: row.get("worktree_per_job")?,
            connector_ids_json: column_json(row, "connector_ids_json")?,
            secret_ref: row.get("secret_ref")?,
            is_local_only: row.get("is_local_only")?,
            enabled: row.get("enabled")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.name),
            enum_text(&self.runtime)?,
            enum_text(&self.mode)?,
            opt_text(&self.account_label),
            opt_text(&self.model),
            opt_real(self.budget_daily_usd),
            text(&self.use_when),
            flag(self.can_spawn),
            flag(self.worktree_per_job),
            json_text(&self.connector_ids_json),
            opt_text(&self.secret_ref),
            flag(self.is_local_only),
            flag(self.enabled),
        ])
    }
}

impl Record for RoutingRule {
    const TABLE: &'static str = "routing_rules";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "ord",
        "conditions_json",
        "agent_id",
        "reason",
        "enabled",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(RoutingRule {
            id: row.get("id")?,
            ord: row.get("ord")?,
            conditions_json: column_json(row, "conditions_json")?,
            agent_id: row.get("agent_id")?,
            reason: row.get("reason")?,
            enabled: row.get("enabled")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            Value::Integer(self.ord),
            json_text(&self.conditions_json),
            text(&self.agent_id),
            text(&self.reason),
            flag(self.enabled),
        ])
    }
}

impl Record for ToolPolicy {
    const TABLE: &'static str = "tool_policies";
    const COLUMNS: &'static [&'static str] = &["id", "agent_id", "tool_pattern", "policy"];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(ToolPolicy {
            id: row.get("id")?,
            agent_id: row.get("agent_id")?,
            tool_pattern: row.get("tool_pattern")?,
            policy: column_enum(row, "policy")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            opt_text(&self.agent_id),
            text(&self.tool_pattern),
            enum_text(&self.policy)?,
        ])
    }
}

pub fn save_agent(conn: &Connection, mut agent: Agent) -> Result<Agent, RepoError> {
    let is_remote_runtime = matches!(
        agent.runtime,
        AgentRuntime::ClaudeCli | AgentRuntime::AnthropicApi
    );
    if agent.is_local_only && is_remote_runtime {
        return Err(RepoError::Invalid(
            "claude-cli and anthropic-api agents cannot be local-only".to_owned(),
        ));
    }
    if agent.id.is_empty() {
        agent.id = new_id();
    }
    upsert(conn, &agent)?;
    Ok(agent)
}

pub fn save_policy(conn: &Connection, mut policy: ToolPolicy) -> Result<ToolPolicy, RepoError> {
    if policy.id.is_empty() {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM tool_policies WHERE agent_id IS ?1 AND tool_pattern = ?2",
                params![policy.agent_id, policy.tool_pattern],
                |row| row.get(0),
            )
            .optional()?;
        policy.id = existing.unwrap_or_else(new_id);
    }
    upsert(conn, &policy)?;
    Ok(policy)
}

pub fn list_rules(conn: &Connection) -> Result<Vec<RoutingRule>, RepoError> {
    super::list_where(conn, "1 = 1", "ord", Vec::new())
}

pub fn save_rules(
    conn: &mut Connection,
    rules: Vec<RoutingRule>,
) -> Result<Vec<RoutingRule>, RepoError> {
    let tx = conn.transaction()?;
    let mut saved: Vec<RoutingRule> = Vec::with_capacity(rules.len());
    for (position, mut rule) in rules.into_iter().enumerate() {
        if rule.id.is_empty() {
            rule.id = new_id();
        }
        rule.ord =
            i64::try_from(position).map_err(|error| RepoError::Invalid(error.to_string()))?;
        saved.push(rule);
    }
    for existing in list::<RoutingRule>(&tx)? {
        if !saved.iter().any(|rule| rule.id == existing.id) {
            delete::<RoutingRule>(&tx, &existing.id)?;
        }
    }
    tx.execute("UPDATE routing_rules SET ord = -rowid", [])?;
    for rule in &saved {
        upsert(&tx, rule)?;
    }
    tx.commit()?;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::db::repo::testing::{sample_agent, test_db};

    fn rule(id: &str, agent_id: &str) -> RoutingRule {
        RoutingRule {
            id: id.to_owned(),
            ord: 0,
            conditions_json: json!({}),
            agent_id: agent_id.to_owned(),
            reason: String::new(),
            enabled: true,
        }
    }

    #[test]
    fn save_rules_reorders_without_violating_ord_uniqueness() {
        let db = test_db("rules");
        db.with_conn(|conn| {
            upsert(conn, &sample_agent("a1"))?;
            save_rules(
                conn,
                vec![rule("r1", "a1"), rule("r2", "a1"), rule("r3", "a1")],
            )?;
            save_rules(conn, vec![rule("r3", "a1"), rule("r1", "a1")])?;
            let order: Vec<String> = list_rules(conn)?.into_iter().map(|rule| rule.id).collect();
            assert_eq!(order, ["r3", "r1"]);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn local_only_is_refused_for_remote_runtimes() {
        let db = test_db("local-only");
        db.with_conn(|conn| {
            let mut agent = sample_agent("a1");
            agent.runtime = AgentRuntime::ClaudeCli;
            let result = save_agent(conn, agent);
            assert!(matches!(result, Err(RepoError::Invalid(_))));
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn save_policy_reuses_the_default_policy_for_the_same_pattern() {
        let db = test_db("policy");
        db.with_conn(|conn| {
            let first = save_policy(
                conn,
                ToolPolicy {
                    id: String::new(),
                    agent_id: None,
                    tool_pattern: "mcp__m365__*".to_owned(),
                    policy: regis_model::Policy::Ask,
                },
            )?;
            let second = save_policy(
                conn,
                ToolPolicy {
                    policy: regis_model::Policy::Deny,
                    id: String::new(),
                    ..first.clone()
                },
            )?;
            assert_eq!(first.id, second.id);
            assert_eq!(list::<ToolPolicy>(conn)?.len(), 1);
            Ok(())
        })
        .expect("repo calls");
    }
}
