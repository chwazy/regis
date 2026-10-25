use std::path::PathBuf;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::db::repo::{self, ItemFilter, JobFilter, RepoError};
use crate::db::Db;
use crate::events::EventBus;
use crate::files::templates::{self, GeneratedFile, TemplatePatch};
use crate::modules::{is_enabled, LocalModuleId};
use crate::sidecar::{HostError, HostHandler, SidecarClient};
use regis_model::{
    Agent, Approval, ApprovalStatus, Brief, Connector, Entity, EntityKind, Fact, FactStatus,
    FileEntry, FileSource, ItemKind, ItemUpsert, Job, JobEvent, JobStatus, Link, LinkProposalRow,
    NewApproval, NewJob, NewJobEvent, RoutingRule, Template, ToolPolicy,
};

#[derive(Clone)]
pub struct StoreContext {
    pub db: Arc<Db>,
    pub bus: EventBus,
    pub data_dir: PathBuf,
}

type StoreMethod = fn(&StoreContext, Value) -> Result<Value, HostError>;

const METHODS: &[(&str, StoreMethod)] = &[
    ("store.items.upsert", items_upsert),
    ("store.items.list", items_list),
    ("store.jobs.create", jobs_create),
    ("store.jobs.get", jobs_get),
    ("store.jobs.list", jobs_list),
    ("store.jobs.listEvents", jobs_list_events),
    ("store.jobs.update", jobs_update),
    ("store.jobs.appendEvent", jobs_append_event),
    ("store.approvals.create", approvals_create),
    ("store.approvals.get", approvals_get),
    ("store.approvals.list", approvals_list),
    ("store.briefs.get", briefs_get),
    ("store.briefs.save", briefs_save),
    ("store.agents.list", agents_list),
    ("store.settings.get", settings_get),
    ("store.policies.list", policies_list),
    ("store.rules.list", rules_list),
    ("store.entities.list", entities_list),
    ("store.links.list", links_list),
    ("store.connectors.list", connectors_list),
    ("store.connectors.recordSync", connectors_record_sync),
    ("store.entities.save", entities_save),
    ("store.links.insertAuto", links_insert_auto),
    ("store.facts.list", facts_list),
    ("store.facts.add", facts_add),
    ("store.facts.delete", facts_delete),
    ("store.settings.set", settings_set),
    ("store.settings.listPrefix", settings_list_prefix),
    ("store.files.list", files_list),
    ("store.sources.list", sources_list),
    ("store.files.get", files_get),
    ("store.files.registerGenerated", files_register_generated),
    ("store.templates.get", templates_get),
    ("store.templates.update", templates_update),
    ("store.chunks.list", chunks_list),
    ("store.chunks.neighbors", chunks_neighbors),
    ("store.brain.entityCard", brain_entity_card),
    ("store.syntheses.list", syntheses_list),
    ("store.syntheses.save", syntheses_save),
    ("store.minutes.context", minutes_context),
    ("store.minutes.save", minutes_save),
];

impl From<RepoError> for HostError {
    fn from(error: RepoError) -> Self {
        match error {
            RepoError::Sqlite(_) => HostError::Internal(error.to_string()),
            _ => HostError::InvalidParams(error.to_string()),
        }
    }
}

pub fn register_host_methods(sidecar: &SidecarClient, context: StoreContext) {
    for (name, method) in METHODS {
        let context = context.clone();
        let method = *method;
        let handler: HostHandler = Arc::new(move |params| {
            let context = context.clone();
            Box::pin(async move { method(&context, params) })
        });
        sidecar.register_host_method(name, handler);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MinutesContextParams {
    transcript_item_id: String,
}

fn minutes_context(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: MinutesContextParams = parse(params)?;
    let result = context
        .db
        .with_conn(|conn| repo::minutes::minutes_context(conn, &params.transcript_item_id))?;
    to_json(&result)
}

fn minutes_save(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let input: repo::minutes::MinutesSave = parse(params)?;
    let note = context
        .db
        .with_conn(|conn| repo::minutes::save_minutes(conn, &input))?;
    to_json(&note)
}

fn parse<T: DeserializeOwned>(params: Value) -> Result<T, HostError> {
    serde_json::from_value(params).map_err(|error| HostError::InvalidParams(error.to_string()))
}

fn to_json<T: Serialize>(value: &T) -> Result<Value, HostError> {
    serde_json::to_value(value).map_err(|error| HostError::Internal(error.to_string()))
}

#[derive(Deserialize)]
struct ItemsUpsertParams {
    items: Vec<ItemUpsert>,
}

fn items_upsert(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: ItemsUpsertParams = parse(params)?;
    let upserted = context
        .db
        .with_conn(|conn| repo::upsert_items(conn, &params.items))?;
    Ok(json!({ "upserted": upserted }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemsListParams {
    kind: Option<ItemKind>,
    connector_id: Option<String>,
    since: Option<String>,
    limit: Option<i64>,
}

fn items_list(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: ItemsListParams = parse(params)?;
    let filter = ItemFilter {
        kind: params.kind,
        connector_id: params.connector_id,
        since: params.since,
        limit: params.limit,
    };
    let items = context
        .db
        .with_conn(|conn| repo::list_items(conn, &filter))?;
    to_json(&items)
}

fn jobs_create(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let new_job: NewJob = parse(params)?;
    let job = context
        .db
        .with_conn(|conn| repo::create_job(conn, &new_job))?;
    context.bus.emit("job.updated", &job);
    to_json(&job)
}

fn jobs_get(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: IdParams = parse(params)?;
    let job: Job = context
        .db
        .with_conn(|conn| repo::require(conn, &params.id))?;
    to_json(&job)
}

#[derive(Deserialize)]
struct JobsListParams {
    status: Option<JobStatus>,
    limit: Option<i64>,
}

fn jobs_list(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: JobsListParams = parse(params)?;
    let filter = JobFilter {
        status: params.status,
        limit: params.limit,
    };
    let jobs: Vec<Job> = context
        .db
        .with_conn(|conn| repo::list_jobs(conn, &filter))?;
    to_json(&jobs)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobsListEventsParams {
    job_id: String,
}

fn jobs_list_events(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: JobsListEventsParams = parse(params)?;
    let events: Vec<JobEvent> = context
        .db
        .with_conn(|conn| repo::list_job_events(conn, &params.job_id))?;
    to_json(&events)
}

#[derive(Deserialize)]
struct JobsUpdateParams {
    id: String,
    patch: Map<String, Value>,
}

fn jobs_update(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: JobsUpdateParams = parse(params)?;
    let job: Job = context
        .db
        .with_conn(|conn| repo::update_job(conn, &params.id, &params.patch))?;
    context.bus.emit("job.updated", &job);
    to_json(&job)
}

fn jobs_append_event(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let new_event: NewJobEvent = parse(params)?;
    let event = context
        .db
        .with_conn(|conn| repo::append_job_event(conn, &new_event))?;
    context.bus.emit("job.event", &event);
    to_json(&event)
}

fn approvals_create(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let new_approval: NewApproval = parse(params)?;
    let approval = context
        .db
        .with_conn(|conn| repo::create_approval(conn, &new_approval))?;
    context.bus.emit("approval.created", &approval);
    to_json(&approval)
}

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

fn approvals_get(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: IdParams = parse(params)?;
    let approval: Approval = context
        .db
        .with_conn(|conn| repo::require(conn, &params.id))?;
    to_json(&approval)
}

#[derive(Deserialize)]
struct ApprovalsListParams {
    status: Option<ApprovalStatus>,
}

fn approvals_list(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: ApprovalsListParams = parse(params)?;
    let approvals: Vec<Approval> = context
        .db
        .with_conn(|conn| repo::list_approvals(conn, params.status))?;
    to_json(&approvals)
}

#[derive(Deserialize)]
struct BriefsGetParams {
    date: String,
}

fn briefs_get(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: BriefsGetParams = parse(params)?;
    let brief: Option<Brief> = context
        .db
        .with_conn(|conn| repo::get_brief_by_date(conn, &params.date))?;
    to_json(&brief)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BriefsSaveParams {
    date: String,
    job_id: Option<String>,
    headline: String,
    sections_json: Value,
}

fn briefs_save(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: BriefsSaveParams = parse(params)?;
    let brief = context.db.with_conn(|conn| {
        repo::save_brief(
            conn,
            &params.date,
            params.job_id,
            params.headline,
            params.sections_json,
        )
    })?;
    context.bus.emit("brief.ready", &brief);
    to_json(&brief)
}

fn agents_list(context: &StoreContext, _params: Value) -> Result<Value, HostError> {
    let agents: Vec<Agent> = context.db.with_conn(|conn| repo::list(conn))?;
    to_json(&agents)
}

#[derive(Deserialize)]
struct KeyParams {
    key: String,
}

fn settings_get(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: KeyParams = parse(params)?;
    let value = context
        .db
        .with_conn(|conn| repo::get_setting(conn, &params.key))?;
    Ok(json!({ "value": value }))
}

fn policies_list(context: &StoreContext, _params: Value) -> Result<Value, HostError> {
    let policies: Vec<ToolPolicy> = context.db.with_conn(|conn| repo::list(conn))?;
    to_json(&policies)
}

fn rules_list(context: &StoreContext, _params: Value) -> Result<Value, HostError> {
    let rules: Vec<RoutingRule> = context.db.with_conn(|conn| repo::list_rules(conn))?;
    to_json(&rules)
}

fn entities_list(context: &StoreContext, _params: Value) -> Result<Value, HostError> {
    let entities: Vec<Entity> = context.db.with_conn(|conn| repo::list(conn))?;
    to_json(&entities)
}

fn links_list(context: &StoreContext, _params: Value) -> Result<Value, HostError> {
    let links: Vec<Link> = context.db.with_conn(|conn| repo::list(conn))?;
    to_json(&links)
}

fn connectors_list(context: &StoreContext, _params: Value) -> Result<Value, HostError> {
    let connectors: Vec<Connector> = context.db.with_conn(|conn| repo::list(conn))?;
    to_json(&connectors)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorsRecordSyncParams {
    id: String,
    status: String,
    last_sync_at: Option<String>,
}

fn connectors_record_sync(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: ConnectorsRecordSyncParams = parse(params)?;
    context.db.with_conn(|conn| {
        repo::record_connector_sync(
            conn,
            &params.id,
            &params.status,
            params.last_sync_at.as_deref(),
        )
    })?;
    Ok(json!({}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntitiesSaveParams {
    id: Option<String>,
    kind: EntityKind,
    name: String,
    #[serde(default = "empty_array")]
    tags_json: Value,
    #[serde(default = "empty_object")]
    data_json: Value,
}

fn empty_array() -> Value {
    json!([])
}

fn empty_object() -> Value {
    json!({})
}

fn entities_save(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: EntitiesSaveParams = parse(params)?;
    let entity = context.db.with_conn(|conn| {
        repo::save_entity(
            conn,
            repo::EntitySave {
                id: params.id,
                kind: params.kind,
                name: params.name,
                tags_json: params.tags_json,
                data_json: params.data_json,
            },
        )
    })?;
    to_json(&entity)
}

fn syntheses_list(context: &StoreContext, _params: Value) -> Result<Value, HostError> {
    let syntheses = context.db.with_conn(|conn| repo::list_syntheses(conn))?;
    to_json(&syntheses)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SynthesesSaveParams {
    entity_id: String,
    text: String,
    source_count: i64,
    signature: String,
    job_id: Option<String>,
}

fn syntheses_save(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: SynthesesSaveParams = parse(params)?;
    let synthesis = context.db.with_conn(|conn| {
        repo::save_synthesis(
            conn,
            repo::SynthesisSave {
                entity_id: params.entity_id,
                text: params.text,
                source_count: params.source_count,
                signature: params.signature,
                job_id: params.job_id,
            },
        )
    })?;
    to_json(&synthesis)
}

#[derive(Deserialize)]
struct LinksInsertAutoParams {
    links: Vec<LinkProposalRow>,
}

fn links_insert_auto(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: LinksInsertAutoParams = parse(params)?;
    let inserted = context
        .db
        .with_conn(|conn| repo::insert_links_if_absent(conn, &params.links, "auto"))?;
    Ok(json!({ "inserted": inserted }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FactsListParams {
    entity_id: Option<String>,
}

fn facts_list(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: FactsListParams = parse(params)?;
    let facts: Vec<Fact> = context
        .db
        .with_conn(|conn| repo::list_facts(conn, params.entity_id.as_deref()))?;
    to_json(&facts)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FactsAddParams {
    entity_id: String,
    text: String,
    source_type: String,
    source_id: String,
    status: FactStatus,
}

fn facts_add(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: FactsAddParams = parse(params)?;
    let fact = context.db.with_conn(|conn| {
        repo::add_fact(
            conn,
            repo::NewFact {
                entity_id: params.entity_id,
                text: params.text,
                source_type: params.source_type,
                source_id: params.source_id,
                status: params.status,
            },
        )
    })?;
    to_json(&fact)
}

fn facts_delete(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: IdParams = parse(params)?;
    let deleted = context
        .db
        .with_conn(|conn| repo::delete::<Fact>(conn, &params.id))?;
    Ok(json!({ "deleted": deleted }))
}

#[derive(Deserialize)]
struct SettingsSetParams {
    key: String,
    value: String,
}

fn settings_set(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: SettingsSetParams = parse(params)?;
    context
        .db
        .with_conn(|conn| repo::set_setting(conn, &params.key, &params.value))?;
    Ok(json!({}))
}

#[derive(Deserialize)]
struct PrefixParams {
    prefix: String,
}

fn settings_list_prefix(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: PrefixParams = parse(params)?;
    let rows = context
        .db
        .with_conn(|conn| repo::list_settings_with_prefix(conn, &params.prefix))?;
    let entries: Vec<Value> = rows
        .into_iter()
        .map(|(key, value)| json!({ "key": key, "value": value }))
        .collect();
    Ok(Value::Array(entries))
}

fn files_list(context: &StoreContext, _params: Value) -> Result<Value, HostError> {
    let files: Vec<FileEntry> = context.db.with_conn(|conn| repo::list(conn))?;
    to_json(&files)
}

fn sources_list(context: &StoreContext, _params: Value) -> Result<Value, HostError> {
    let sources: Vec<FileSource> = context.db.with_conn(|conn| repo::list(conn))?;
    to_json(&sources)
}

fn files_get(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: IdParams = parse(params)?;
    let file: FileEntry = context
        .db
        .with_conn(|conn| repo::require(conn, &params.id))?;
    to_json(&file)
}

fn files_register_generated(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let generated: GeneratedFile = parse(params)?;
    let entry = templates::register_generated(&context.db, &context.data_dir, &generated)
        .map_err(|error| HostError::InvalidParams(error.to_string()))?;
    to_json(&entry)
}

fn templates_get(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: IdParams = parse(params)?;
    let template: Template = context
        .db
        .with_conn(|conn| repo::require(conn, &params.id))?;
    to_json(&template)
}

#[derive(Deserialize)]
struct TemplatesUpdateParams {
    id: String,
    patch: TemplatePatch,
}

fn templates_update(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: TemplatesUpdateParams = parse(params)?;
    let template = templates::update_template(&context.db, &params.id, &params.patch)?;
    to_json(&template)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunksListParams {
    owner_type: String,
    owner_id: String,
}

fn chunks_list(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: ChunksListParams = parse(params)?;
    let chunks = context
        .db
        .with_conn(|conn| repo::list_chunk_texts(conn, &params.owner_type, &params.owner_id))?;
    to_json(&chunks)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIdParams {
    file_id: String,
}

fn chunks_neighbors(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: FileIdParams = parse(params)?;
    if !(crate::demo::is_enabled() || is_enabled(&context.db, LocalModuleId::Embeddings)) {
        return to_json(&Vec::<Value>::new());
    }
    let neighbors = context
        .db
        .with_conn(|conn| repo::chunk_neighbors(conn, &params.file_id))?;
    to_json(&neighbors)
}

fn brain_entity_card(context: &StoreContext, params: Value) -> Result<Value, HostError> {
    let params: IdParams = parse(params)?;
    let card = context
        .db
        .with_conn(|conn| repo::entity_card(conn, &params.id))?;
    to_json(&card)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::db::repo::testing::{sample_agent, sample_connector, test_db};
    use crate::events::{EventSink, RegisEvent};

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<RegisEvent>>,
    }

    impl EventSink for RecordingSink {
        fn publish(&self, event: RegisEvent) {
            self.events.lock().expect("events lock").push(event);
        }
    }

    fn call(context: &StoreContext, method: &str, params: Value) -> Result<Value, HostError> {
        let (_, handler) = METHODS
            .iter()
            .find(|(name, _)| *name == method)
            .expect("registered method");
        handler(context, params)
    }

    fn context_with_agent(name: &str) -> (StoreContext, Arc<RecordingSink>) {
        let db = Arc::new(test_db(name));
        db.with_conn(|conn| repo::upsert(conn, &sample_agent("a1")))
            .expect("seed agent");
        let sink = Arc::new(RecordingSink::default());
        let context = StoreContext {
            db,
            bus: EventBus::new(sink.clone()),
            data_dir: std::env::temp_dir(),
        };
        (context, sink)
    }

    fn new_job_params() -> Value {
        json!({
            "parentId": null, "agentId": "a1", "kind": "task", "title": "Write report",
            "prompt": "Write the report", "status": "queued", "sessionId": null, "cwd": null,
            "routingReason": null, "resultText": null, "error": null,
            "startedAt": null, "endedAt": null
        })
    }

    #[test]
    fn chunk_neighbors_are_only_proposed_when_semantic_search_is_enabled() {
        let (context, _sink) = context_with_agent("rpc-neighbors");
        context
            .db
            .with_conn(|conn| {
                for (owner, component) in [("new", 0.0_f32), ("near", 0.1)] {
                    conn.execute(
                        "INSERT INTO chunks (owner_type, owner_id, ord, text) VALUES ('file', ?1, 0, 'texte')",
                        [owner],
                    )?;
                    let mut vector = vec![0.0_f32; 1024];
                    vector[0] = 1.0;
                    vector[1] = component;
                    conn.execute(
                        "INSERT INTO chunks_vec (rowid, embedding) VALUES (?1, ?2)",
                        rusqlite::params![
                            conn.last_insert_rowid(),
                            crate::files::embed::vector_to_blob(&vector)
                        ],
                    )?;
                }
                Ok(())
            })
            .expect("seed vectors");
        let params = json!({ "fileId": "new" });

        let disabled = call(&context, "store.chunks.neighbors", params.clone()).expect("disabled");
        crate::modules::set_enabled(&context.db, LocalModuleId::Embeddings, true).expect("enable");
        let enabled = call(&context, "store.chunks.neighbors", params).expect("enabled");

        assert_eq!(disabled, json!([]));
        assert_eq!(enabled[0]["ownerId"], "near");
    }

    #[test]
    fn entities_and_links_lists_start_empty() {
        let (context, _sink) = context_with_agent("rpc-entities");

        let entities = call(&context, "store.entities.list", json!({})).expect("entities");
        let links = call(&context, "store.links.list", json!({})).expect("links");

        assert_eq!(entities, json!([]));
        assert_eq!(links, json!([]));
    }

    #[test]
    fn brain_host_methods_save_entities_links_facts_and_settings() {
        let (context, _sink) = context_with_agent("rpc-brain");

        let client = call(
            &context,
            "store.entities.save",
            json!({ "kind": "client", "name": "Atelier", "dataJson": { "externalId": "10" } }),
        )
        .expect("save entity");
        let id = client["id"].as_str().expect("entity id").to_owned();
        let renamed = call(
            &context,
            "store.entities.save",
            json!({ "id": id, "kind": "client", "name": "Atelier SA" }),
        )
        .expect("rename entity");
        let links = json!({ "links": [
            { "fromType": "item", "fromId": "i1", "toEntityId": id, "rel": "about", "confidence": 0.8 }
        ] });
        let first = call(&context, "store.links.insertAuto", links.clone()).expect("insert links");
        let second = call(&context, "store.links.insertAuto", links).expect("insert again");
        let fact = call(
            &context,
            "store.facts.add",
            json!({ "entityId": id, "text": "Paie a 45 jours", "sourceType": "item", "sourceId": "i1", "status": "inferred" }),
        )
        .expect("add fact");
        let listed =
            call(&context, "store.facts.list", json!({ "entityId": id })).expect("list facts");
        call(&context, "store.facts.delete", json!({ "id": fact["id"] })).expect("delete fact");
        let after = call(&context, "store.facts.list", json!({})).expect("list all facts");
        call(
            &context,
            "store.settings.set",
            json!({ "key": "brain.extracted.item.i1", "value": "done" }),
        )
        .expect("set setting");
        let settings = call(
            &context,
            "store.settings.listPrefix",
            json!({ "prefix": "brain.extracted." }),
        )
        .expect("list settings");
        let all_links = call(&context, "store.links.list", json!({})).expect("links");

        assert_eq!(renamed["name"], "Atelier SA");
        assert_eq!(renamed["createdAt"], client["createdAt"]);
        assert_eq!(first["inserted"], 1);
        assert_eq!(second["inserted"], 0);
        assert_eq!(all_links[0]["origin"], "auto");
        assert_eq!(all_links[0]["confidence"], 0.8);
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
        assert_eq!(after, json!([]));
        assert_eq!(
            settings,
            json!([{ "key": "brain.extracted.item.i1", "value": "done" }])
        );
        let invalid = call(
            &context,
            "store.entities.save",
            json!({ "kind": "client", "name": " " }),
        );
        assert!(matches!(invalid, Err(HostError::InvalidParams(_))));
    }

    #[test]
    fn settings_get_returns_stored_value_or_null() {
        let (context, _sink) = context_with_agent("rpc-settings");
        context
            .db
            .with_conn(|conn| repo::set_setting(conn, "agents.claudeBin", "claude"))
            .expect("set setting");

        let present = call(
            &context,
            "store.settings.get",
            json!({ "key": "agents.claudeBin" }),
        )
        .expect("get present");
        let absent = call(
            &context,
            "store.settings.get",
            json!({ "key": "agents.nope" }),
        )
        .expect("get absent");

        assert_eq!(present["value"], "claude");
        assert!(absent["value"].is_null());
    }

    #[test]
    fn jobs_update_emits_event() {
        let (context, sink) = context_with_agent("rpc-update");
        let created = call(&context, "store.jobs.create", new_job_params()).expect("create");
        let id = created["id"].as_str().expect("job id").to_owned();

        let updated = call(
            &context,
            "store.jobs.update",
            json!({ "id": id, "patch": { "status": "running", "tokensIn": 12 } }),
        )
        .expect("update");

        assert_eq!(updated["status"], "running");
        assert_eq!(updated["tokensIn"], 12);
        let events = sink.events.lock().expect("events lock");
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].topic, "job.updated");
        assert_eq!(events[1].payload["id"], id);
        assert_eq!(events[1].payload["status"], "running");
    }

    #[test]
    fn connectors_record_sync_keeps_last_sync_on_error() {
        let (context, _) = context_with_agent("rpc-record-sync");
        context
            .db
            .with_conn(|conn| repo::upsert(conn, &sample_connector("c1")))
            .expect("seed connector");

        call(
            &context,
            "store.connectors.recordSync",
            json!({ "id": "c1", "status": "ok", "lastSyncAt": "2026-01-02T00:00:00.000Z" }),
        )
        .expect("record ok");
        call(
            &context,
            "store.connectors.recordSync",
            json!({ "id": "c1", "status": "error" }),
        )
        .expect("record error");

        let connectors = call(&context, "store.connectors.list", json!({})).expect("list");
        assert_eq!(connectors[0]["status"], "error");
        assert_eq!(connectors[0]["lastSyncAt"], "2026-01-02T00:00:00.000Z");
        let missing = call(
            &context,
            "store.connectors.recordSync",
            json!({ "id": "nope", "status": "ok" }),
        );
        assert!(matches!(missing, Err(HostError::InvalidParams(_))));
    }

    #[test]
    fn jobs_get_list_and_list_events_read_back_created_rows() {
        let (context, sink) = context_with_agent("rpc-jobs-read");
        let created = call(&context, "store.jobs.create", new_job_params()).expect("create");
        let id = created["id"].clone();
        call(
            &context,
            "store.jobs.appendEvent",
            json!({ "jobId": id, "at": "2026-01-01T00:00:00.000Z", "type": "start", "summary": "go" }),
        )
        .expect("append event");

        let fetched = call(&context, "store.jobs.get", json!({ "id": id })).expect("get");
        let queued =
            call(&context, "store.jobs.list", json!({ "status": "queued" })).expect("list");
        let running =
            call(&context, "store.jobs.list", json!({ "status": "running" })).expect("list");
        let events =
            call(&context, "store.jobs.listEvents", json!({ "jobId": id })).expect("events");

        assert_eq!(fetched["title"], "Write report");
        assert_eq!(queued.as_array().map(Vec::len), Some(1));
        assert_eq!(running.as_array().map(Vec::len), Some(0));
        assert_eq!(events[0]["summary"], "go");
        assert_eq!(
            sink.events.lock().expect("events lock")[0].topic,
            "job.updated"
        );
    }

    #[test]
    fn briefs_save_upserts_one_row_per_date_and_emits_ready() {
        let (context, sink) = context_with_agent("rpc-briefs");
        let params = |headline: &str| {
            json!({ "date": "2026-10-22", "jobId": null, "headline": headline,
                    "sectionsJson": { "priorities": [], "quickActions": [] } })
        };

        let first = call(&context, "store.briefs.save", params("one")).expect("save");
        let second = call(&context, "store.briefs.save", params("two")).expect("save again");
        let fetched = call(
            &context,
            "store.briefs.get",
            json!({ "date": "2026-10-22" }),
        )
        .expect("get");
        let missing = call(
            &context,
            "store.briefs.get",
            json!({ "date": "2026-10-23" }),
        )
        .expect("get");

        assert_eq!(first["id"], second["id"]);
        assert_eq!(fetched["headline"], "two");
        assert!(missing.is_null());
        let events = sink.events.lock().expect("events lock");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.topic == "brief.ready")
                .count(),
            2
        );
    }

    #[test]
    fn approvals_list_filters_by_status() {
        let (context, _sink) = context_with_agent("rpc-approvals-list");
        let created = call(&context, "store.jobs.create", new_job_params()).expect("create");
        call(
            &context,
            "store.approvals.create",
            json!({ "jobId": created["id"], "tool": "mcp__x__y", "inputJson": {}, "decisionNote": null, "decidedAt": null }),
        )
        .expect("create approval");

        let pending = call(
            &context,
            "store.approvals.list",
            json!({ "status": "pending" }),
        )
        .expect("list");
        let approved = call(
            &context,
            "store.approvals.list",
            json!({ "status": "approved" }),
        )
        .expect("list");

        assert_eq!(pending.as_array().map(Vec::len), Some(1));
        assert_eq!(approved.as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn jobs_update_rejects_unknown_fields() {
        let (context, sink) = context_with_agent("rpc-update-invalid");
        let created = call(&context, "store.jobs.create", new_job_params()).expect("create");

        let result = call(
            &context,
            "store.jobs.update",
            json!({ "id": created["id"], "patch": { "secret": "x" } }),
        );

        assert!(matches!(result, Err(HostError::InvalidParams(_))));
        assert_eq!(sink.events.lock().expect("events lock").len(), 1);
    }

    #[test]
    fn append_event_and_approval_create_emit_events() {
        let (context, sink) = context_with_agent("rpc-events");
        let created = call(&context, "store.jobs.create", new_job_params()).expect("create");
        let job_id = created["id"].clone();

        let event = call(
            &context,
            "store.jobs.appendEvent",
            json!({ "jobId": job_id, "at": "2026-01-01T00:00:00.000Z", "type": "start", "summary": "go" }),
        )
        .expect("append event");
        let approval = call(
            &context,
            "store.approvals.create",
            json!({ "jobId": job_id, "tool": "mcp__x__y", "inputJson": {}, "decisionNote": null, "decidedAt": null }),
        )
        .expect("create approval");

        assert_eq!(event["seq"], 1);
        assert_eq!(approval["status"], "pending");
        let topics: Vec<String> = sink
            .events
            .lock()
            .expect("events lock")
            .iter()
            .map(|event| event.topic.clone())
            .collect();
        assert_eq!(topics, ["job.updated", "job.event", "approval.created"]);
    }
}
