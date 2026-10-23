use std::path::Path;

use serde_json::json;

use crate::modules::manager::selected_stt_model;
use crate::stt::state::SttModelState;
use crate::stt::SttState;
use regis_core::db::repo::{self, RepoError};
use regis_core::db::Db;
use regis_core::files::sources::{
    ensure_regis_sources, models_dir, regis_source, register_imported, SourceError,
};
use regis_core::modules::{set_enabled, LocalModuleId, ModuleError};
use regis_model::{
    Agent, AgentMode, AgentRuntime, Connector, FileEntry, Policy, Template, ToolPolicy,
};

const FILESYSTEM_KIND: &str = "filesystem";
const FILESYSTEM_PACKAGE: &str = "@modelcontextprotocol/server-filesystem@2.0.0";
const FILESYSTEM_SEED_KEY: &str = "seed.filesystem";
const AGENTS_SEED_KEY: &str = "seed.agents";
const POLICIES_SEED_KEY: &str = "seed.toolPolicies";
const DEFAULT_TOOL_POLICIES: &[(&str, Policy)] = &[
    ("mcp__m365__*send*", Policy::Ask),
    ("mcp__microsoft_365__*send*", Policy::Ask),
    ("mcp__odoo__timesheet_create", Policy::Ask),
    ("mcp__odoo__invoice_*", Policy::Auto),
    ("mcp__filesystem__write*", Policy::Ask),
];
const DASHBOARD_SEED_KEY: &str = "seed.dashboard";
const BRAIN_POLICIES_SEED_KEY: &str = "seed.brainToolPolicies";
const BRAIN_TOOL_POLICIES: &[(&str, Policy)] = &[("mcp__regis__brain_add_fact", Policy::Auto)];
const TEMPLATE_POLICIES_SEED_KEY: &str = "seed.templateToolPolicies";
const TEMPLATE_TOOL_POLICIES: &[(&str, Policy)] = &[("mcp__regis__render_template", Policy::Auto)];
const MINUTES_TEMPLATE_SEED_KEY: &str = "seed.minutesTemplate";
const MINUTES_TEMPLATE_FILE: &str = "pv-reunion.md";
const MINUTES_TEMPLATE_BODY: &str = include_str!("seed/pv-reunion.md");
const LOCAL_MODULES_SEED_KEY: &str = "seed.localModules";
const DEFAULT_API_MODEL_KEY: &str = "agents.defaultApiModel";
const DEFAULT_API_MODEL: &str = "claude-haiku-5-5";
const ANTHROPIC_SECRET_REF: &str = "agent-anthropic-api";

#[derive(Debug, thiserror::Error)]
pub enum SeedError {
    #[error(transparent)]
    Repo(#[from] RepoError),
    #[error("could not create the library directory: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Source(#[from] SourceError),
}

pub fn seed_defaults(db: &Db, data_dir: &Path) -> Result<(), SeedError> {
    seed_filesystem_connector(db, data_dir)?;
    seed_agents(db)?;
    seed_tool_policies(db)?;
    seed_brain_connector(db)?;
    seed_brain_tool_policies(db)?;
    seed_template_tool_policies(db)?;
    seed_minutes_template(db, data_dir)?;
    seed_dashboard(db)?;
    seed_local_modules(db, data_dir)
}

/// Une base existante garde ce qu'elle utilise déjà : voix si le modèle STT est valide,
/// recherche sémantique si des vecteurs existent. Ne dépend pas de la disponibilité d'Ollama.
fn seed_local_modules(db: &Db, data_dir: &Path) -> Result<(), SeedError> {
    if db
        .with_conn(|conn| repo::get_setting(conn, LOCAL_MODULES_SEED_KEY))?
        .is_some()
    {
        return Ok(());
    }
    let model_id = selected_stt_model(db);
    let voice_ready =
        SttState::new().status(data_dir, &model_id, false).state == SttModelState::Ready;
    apply_local_modules_seed(db, voice_ready)
}

fn apply_local_modules_seed(db: &Db, voice_ready: bool) -> Result<(), SeedError> {
    if voice_ready {
        set_enabled(db, LocalModuleId::Voice, true).map_err(module_error)?;
    }
    let has_vectors = db.with_conn(|conn| {
        Ok(
            conn.query_row("SELECT EXISTS (SELECT 1 FROM chunks_vec)", [], |row| {
                row.get::<_, bool>(0)
            })?,
        )
    })?;
    if has_vectors {
        set_enabled(db, LocalModuleId::Embeddings, true).map_err(module_error)?;
    }
    db.with_conn(|conn| repo::set_setting(conn, LOCAL_MODULES_SEED_KEY, "done"))?;
    Ok(())
}

fn module_error(error: ModuleError) -> SeedError {
    match error {
        ModuleError::Repo(error) => SeedError::Repo(error),
        other => SeedError::Repo(RepoError::Invalid(other.to_string())),
    }
}

/// Modèle Markdown du PV, déposé une seule fois dans `library/models` (jamais écrasé ensuite).
fn seed_minutes_template(db: &Db, data_dir: &Path) -> Result<(), SeedError> {
    let seeded = db.with_conn(|conn| repo::get_setting(conn, MINUTES_TEMPLATE_SEED_KEY))?;
    if seeded.is_some() {
        return Ok(());
    }
    ensure_regis_sources(db, data_dir)?;
    let directory = models_dir(data_dir);
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(MINUTES_TEMPLATE_FILE);
    if !path.exists() {
        std::fs::write(&path, MINUTES_TEMPLATE_BODY)?;
    }
    let source = regis_source(db, &directory)?;
    let file = register_imported(db, &source, &path)?;
    create_template_if_missing(db, &file)?;
    db.with_conn(|conn| repo::set_setting(conn, MINUTES_TEMPLATE_SEED_KEY, "done"))?;
    Ok(())
}

fn create_template_if_missing(db: &Db, file: &FileEntry) -> Result<(), RepoError> {
    db.with_conn(|conn| {
        let existing: Vec<Template> = repo::list_where(
            conn,
            "file_id = ?1",
            "rowid",
            vec![rusqlite::types::Value::Text(file.id.clone())],
        )?;
        if !existing.is_empty() {
            return Ok(());
        }
        repo::upsert(
            conn,
            &Template {
                id: repo::new_id(),
                file_id: file.id.clone(),
                name: "pv-reunion".to_owned(),
                instructions: "Procès-verbal de réunion : les variables pv.* sont remplies depuis les données du PV."
                    .to_owned(),
                variables_json: json!([]),
                version: 1,
            },
        )
    })
}

fn seed_dashboard(db: &Db) -> Result<(), SeedError> {
    db.with_conn(|conn| {
        if repo::get_setting(conn, DASHBOARD_SEED_KEY)?.is_some() {
            return Ok(());
        }
        repo::seed_default_dashboard(conn)?;
        repo::set_setting(conn, DASHBOARD_SEED_KEY, "done")
    })?;
    Ok(())
}

fn seed_brain_connector(db: &Db) -> Result<(), SeedError> {
    db.with_conn(|conn| repo::ensure_brain_connector(conn).map(|_| ()))?;
    Ok(())
}

fn seed_brain_tool_policies(db: &Db) -> Result<(), SeedError> {
    db.with_conn(|conn| {
        if repo::get_setting(conn, BRAIN_POLICIES_SEED_KEY)?.is_some() {
            return Ok(());
        }
        for (pattern, policy) in BRAIN_TOOL_POLICIES {
            repo::save_policy(
                conn,
                ToolPolicy {
                    id: String::new(),
                    agent_id: None,
                    tool_pattern: (*pattern).to_owned(),
                    policy: *policy,
                },
            )?;
        }
        repo::set_setting(conn, BRAIN_POLICIES_SEED_KEY, "done")
    })?;
    Ok(())
}

fn seed_template_tool_policies(db: &Db) -> Result<(), SeedError> {
    db.with_conn(|conn| {
        if repo::get_setting(conn, TEMPLATE_POLICIES_SEED_KEY)?.is_some() {
            return Ok(());
        }
        for (pattern, policy) in TEMPLATE_TOOL_POLICIES {
            repo::save_policy(
                conn,
                ToolPolicy {
                    id: String::new(),
                    agent_id: None,
                    tool_pattern: (*pattern).to_owned(),
                    policy: *policy,
                },
            )?;
        }
        repo::set_setting(conn, TEMPLATE_POLICIES_SEED_KEY, "done")
    })?;
    Ok(())
}

fn seed_tool_policies(db: &Db) -> Result<(), SeedError> {
    db.with_conn(|conn| {
        if repo::get_setting(conn, POLICIES_SEED_KEY)?.is_some() {
            return Ok(());
        }
        for (pattern, policy) in DEFAULT_TOOL_POLICIES {
            repo::save_policy(
                conn,
                ToolPolicy {
                    id: String::new(),
                    agent_id: None,
                    tool_pattern: (*pattern).to_owned(),
                    policy: *policy,
                },
            )?;
        }
        repo::set_setting(conn, POLICIES_SEED_KEY, "done")
    })?;
    Ok(())
}

fn seed_agents(db: &Db) -> Result<(), SeedError> {
    db.with_conn(|conn| {
        if repo::get_setting(conn, AGENTS_SEED_KEY)?.is_some() {
            return Ok(());
        }
        let existing: Vec<Agent> = repo::list(conn)?;
        if existing.is_empty() {
            for agent in default_agents() {
                repo::save_agent(conn, agent)?;
            }
        }
        if repo::get_setting(conn, DEFAULT_API_MODEL_KEY)?.is_none() {
            repo::set_setting(conn, DEFAULT_API_MODEL_KEY, DEFAULT_API_MODEL)?;
        }
        repo::set_setting(conn, AGENTS_SEED_KEY, "done")
    })?;
    Ok(())
}

fn default_agents() -> Vec<Agent> {
    let base = Agent {
        id: String::new(),
        name: String::new(),
        runtime: AgentRuntime::ClaudeCli,
        mode: AgentMode::Headless,
        account_label: None,
        model: None,
        budget_daily_usd: None,
        use_when: String::new(),
        can_spawn: false,
        worktree_per_job: false,
        connector_ids_json: json!([]),
        secret_ref: None,
        is_local_only: false,
        enabled: true,
    };
    vec![
        Agent {
            name: "Claude Code CLI".to_owned(),
            account_label: Some("Abonnement Claude Code".to_owned()),
            use_when: "Rédaction de documents clients, code et refacto dans un repo, tâches longues multi-étapes. Pas pour du tri de mails en masse.".to_owned(),
            worktree_per_job: true,
            ..base.clone()
        },
        Agent {
            name: "Anthropic API".to_owned(),
            runtime: AgentRuntime::AnthropicApi,
            mode: AgentMode::Api,
            account_label: Some("Clé API".to_owned()),
            model: Some(DEFAULT_API_MODEL.to_owned()),
            use_when: "Tri et résumé de mails, tâches courtes à fort volume et faible complexité.".to_owned(),
            secret_ref: Some(ANTHROPIC_SECRET_REF.to_owned()),
            ..base.clone()
        },
        Agent {
            name: "Ollama local".to_owned(),
            runtime: AgentRuntime::Ollama,
            mode: AgentMode::Api,
            account_label: Some("Local".to_owned()),
            use_when: "Données confidentielles qui ne doivent pas quitter le poste.".to_owned(),
            is_local_only: true,
            ..base
        },
    ]
}

fn seed_filesystem_connector(db: &Db, data_dir: &Path) -> Result<(), SeedError> {
    let library_dir = data_dir.join("library");
    db.with_conn(|conn| {
        if repo::get_setting(conn, FILESYSTEM_SEED_KEY)?.is_some() {
            return Ok(());
        }
        let existing: Vec<Connector> = repo::list(conn)?;
        if !existing
            .iter()
            .any(|connector| connector.kind == FILESYSTEM_KIND)
        {
            std::fs::create_dir_all(&library_dir)
                .map_err(|error| RepoError::Invalid(error.to_string()))?;
            repo::save_connector(
                conn,
                Connector {
                    id: String::new(),
                    kind: FILESYSTEM_KIND.to_owned(),
                    name: "filesystem".to_owned(),
                    transport: "stdio".to_owned(),
                    command: Some("npx".to_owned()),
                    args_json: json!(["-y", FILESYSTEM_PACKAGE, library_dir.to_string_lossy()]),
                    url: None,
                    env_json: json!({}),
                    secret_ref: None,
                    enabled: false,
                    sync_json: json!({}),
                    status: "unknown".to_owned(),
                    last_sync_at: None,
                    created_at: String::new(),
                },
            )?;
        }
        repo::set_setting(conn, FILESYSTEM_SEED_KEY, "done")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use regis_core::db::repo::testing::test_db;

    #[test]
    fn filesystem_connector_is_seeded_once_and_disabled() {
        let db = test_db("seed-filesystem");
        let data_dir = std::env::temp_dir().join(format!("regis-seed-test-{}", std::process::id()));

        seed_defaults(&db, &data_dir).expect("first seed");
        seed_defaults(&db, &data_dir).expect("second seed");

        let connectors: Vec<Connector> = db.with_conn(|conn| repo::list(conn)).expect("list");
        let filesystem: Vec<&Connector> = connectors
            .iter()
            .filter(|connector| connector.kind == FILESYSTEM_KIND)
            .collect();
        assert_eq!(filesystem.len(), 1);
        assert!(!filesystem[0].enabled);
        assert_eq!(filesystem[0].transport, "stdio");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn minutes_template_is_seeded_once_and_never_overwritten() {
        let db = test_db("seed-minutes");
        let data_dir = std::env::temp_dir().join(format!("regis-seed-pv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);

        seed_defaults(&db, &data_dir).expect("first seed");
        let path = models_dir(&data_dir).join(MINUTES_TEMPLATE_FILE);
        assert!(std::fs::read_to_string(&path)
            .expect("seeded file")
            .contains("{{pv.resume}}"));
        std::fs::write(&path, "modifié {{pv.titre}}").expect("edit");
        seed_defaults(&db, &data_dir).expect("second seed");
        seed_defaults(&db, &data_dir).expect("third seed");

        assert_eq!(
            std::fs::read_to_string(&path).expect("file"),
            "modifié {{pv.titre}}"
        );
        let templates: Vec<Template> = db.with_conn(|conn| repo::list(conn)).expect("list");
        let seeded: Vec<&Template> = templates
            .iter()
            .filter(|template| template.name == "pv-reunion")
            .collect();
        assert_eq!(seeded.len(), 1);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn work_dashboard_is_seeded_once() {
        let db = test_db("seed-dashboard");
        let data_dir = std::env::temp_dir().join(format!("regis-seed-dash-{}", std::process::id()));

        seed_defaults(&db, &data_dir).expect("first seed");
        seed_defaults(&db, &data_dir).expect("second seed");

        db.with_conn(|conn| {
            let views = repo::list_dashboards(conn)?;
            assert_eq!(views.len(), 1);
            assert_eq!(views[0].name, "Travail");
            let kinds: Vec<String> = repo::list_widgets(conn, &views[0].id)?
                .into_iter()
                .map(|widget| widget.kind)
                .collect();
            for expected in [
                "inbox",
                "hours_by_project",
                "week_agenda",
                "odoo_tasks",
                "invoices",
                "jobs",
                "recent_files",
            ] {
                assert!(kinds.iter().any(|kind| kind == expected), "{expected}");
            }
            Ok(())
        })
        .expect("dashboards");
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn brain_connector_exists_once_after_several_startups() {
        let db = test_db("seed-brain");
        let data_dir =
            std::env::temp_dir().join(format!("regis-seed-brain-{}", std::process::id()));

        seed_defaults(&db, &data_dir).expect("first seed");
        seed_defaults(&db, &data_dir).expect("second seed");
        seed_defaults(&db, &data_dir).expect("third seed");

        let connectors: Vec<Connector> = db.with_conn(|conn| repo::list(conn)).expect("list");
        let brain: Vec<&Connector> = connectors
            .iter()
            .filter(|connector| connector.kind == "brain")
            .collect();
        assert_eq!(brain.len(), 1);
        assert_eq!(brain[0].transport, "builtin");
        assert_eq!(brain[0].name, "Second cerveau");
        let policies: Vec<ToolPolicy> = db.with_conn(|conn| repo::list(conn)).expect("policies");
        assert_eq!(
            policies
                .iter()
                .filter(|policy| policy.tool_pattern == "mcp__regis__brain_add_fact")
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn default_agents_are_seeded_once_with_consistent_locality() {
        let db = test_db("seed-agents");
        let data_dir =
            std::env::temp_dir().join(format!("regis-seed-agents-{}", std::process::id()));

        seed_defaults(&db, &data_dir).expect("first seed");
        seed_defaults(&db, &data_dir).expect("second seed");

        let agents: Vec<Agent> = db.with_conn(|conn| repo::list(conn)).expect("list");
        assert_eq!(agents.len(), 3);
        for agent in &agents {
            let is_remote = matches!(
                agent.runtime,
                AgentRuntime::ClaudeCli | AgentRuntime::AnthropicApi
            );
            assert_eq!(agent.is_local_only, !is_remote, "{}", agent.name);
        }
        let api = agents
            .iter()
            .find(|agent| agent.runtime == AgentRuntime::AnthropicApi)
            .expect("api agent");
        assert_eq!(api.model.as_deref(), Some(DEFAULT_API_MODEL));
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn default_tool_policies_are_seeded_once() {
        let db = test_db("seed-policies");
        let data_dir =
            std::env::temp_dir().join(format!("regis-seed-policies-{}", std::process::id()));

        seed_defaults(&db, &data_dir).expect("first seed");
        seed_defaults(&db, &data_dir).expect("second seed");

        let policies: Vec<ToolPolicy> = db.with_conn(|conn| repo::list(conn)).expect("list");
        assert_eq!(
            policies.len(),
            DEFAULT_TOOL_POLICIES.len() + BRAIN_TOOL_POLICIES.len() + TEMPLATE_TOOL_POLICIES.len()
        );
        let send = policies
            .iter()
            .find(|policy| policy.tool_pattern == "mcp__m365__*send*")
            .expect("send policy");
        assert_eq!(send.policy, Policy::Ask);
        assert!(send.agent_id.is_none());
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    fn insert_vector(db: &Db) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO chunks (owner_type, owner_id, ord, text) VALUES ('file', 'f1', 0, 'texte')",
                [],
            )?;
            conn.execute(
                "INSERT INTO chunks_vec (rowid, embedding) VALUES (?1, ?2)",
                rusqlite::params![
                    conn.last_insert_rowid(),
                    regis_core::files::embed::vector_to_blob(&vec![0.5_f32; 1024])
                ],
            )?;
            Ok(())
        })
        .expect("vector");
    }

    fn setting(db: &Db, id: LocalModuleId) -> Option<String> {
        db.with_conn(|conn| repo::get_setting(conn, regis_core::modules::setting_key(id)))
            .expect("setting")
    }

    #[test]
    fn local_modules_stay_off_on_a_fresh_database() {
        let db = test_db("seed-modules-fresh");
        let data_dir =
            std::env::temp_dir().join(format!("regis-seed-modules-{}", std::process::id()));
        seed_defaults(&db, &data_dir).expect("seed");
        assert_eq!(setting(&db, LocalModuleId::Voice), None);
        assert_eq!(setting(&db, LocalModuleId::Embeddings), None);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn existing_usage_keeps_its_modules_and_a_second_pass_changes_nothing() {
        let db = test_db("seed-modules-existing");
        insert_vector(&db);
        apply_local_modules_seed(&db, true).expect("seed");
        assert_eq!(setting(&db, LocalModuleId::Voice).as_deref(), Some("true"));
        assert_eq!(
            setting(&db, LocalModuleId::Embeddings).as_deref(),
            Some("true")
        );

        set_enabled(&db, LocalModuleId::Voice, false).expect("user disables");
        let data_dir =
            std::env::temp_dir().join(format!("regis-seed-modules2-{}", std::process::id()));
        seed_local_modules(&db, &data_dir).expect("second pass");
        assert_eq!(setting(&db, LocalModuleId::Voice).as_deref(), Some("false"));
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn a_voice_model_alone_enables_voice_only() {
        let db = test_db("seed-modules-voice");
        apply_local_modules_seed(&db, true).expect("seed");
        assert_eq!(setting(&db, LocalModuleId::Voice).as_deref(), Some("true"));
        assert_eq!(setting(&db, LocalModuleId::Embeddings), None);
    }

    #[test]
    fn demo_seed_keeps_only_the_simulated_agent_and_adds_disabled_synced_sources() {
        let db = test_db("seed-demo");
        seed_defaults(&db, &std::env::temp_dir().join("regis-demo-seed-test")).unwrap();
        regis_core::demo::seed(&db).unwrap();
        regis_core::demo::seed(&db).unwrap();
        let (agents, connectors, extractions) = db
            .with_conn(|conn| {
                Ok((
                    repo::list::<Agent>(conn)?,
                    repo::list::<Connector>(conn)?,
                    repo::get_setting(conn, "brain.maxExtractionsPerDay")?,
                ))
            })
            .unwrap();
        let enabled: Vec<_> = agents.iter().filter(|agent| agent.enabled).collect();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].runtime, AgentRuntime::ClaudeCli);
        assert!(!enabled[0].worktree_per_job);
        let sources: Vec<_> = connectors
            .iter()
            .filter(|connector| connector.kind == "m365" || connector.kind == "odoo")
            .collect();
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().all(|connector| !connector.enabled
            && connector.status == "ok"
            && connector.last_sync_at.is_some()));
        assert_eq!(extractions.as_deref(), Some("0"));
    }
}
