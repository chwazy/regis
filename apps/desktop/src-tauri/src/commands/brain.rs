use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::AppState;
use regis_core::db::repo;
use regis_core::db::Db;
use regis_core::modules::embeddings::active_embedder;
use regis_core::search;
use regis_core::sidecar::{HostError, HostHandler, SidecarClient};
use regis_model::{
    Entity, EntityCard, EntityKind, EntitySummary, Fact, FactDecision, GlobalSearchResult, Item,
};

const SEARCH_POOL: usize = 12;

fn describe(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub async fn global_search_in(db: &Db, query: &str) -> Result<GlobalSearchResult, String> {
    let hits = if query.trim().is_empty() {
        Vec::new()
    } else {
        let embedder = active_embedder(db).await;
        // Sans embeddings (module inactif ou Ollama absent), la recherche d'entités et de titres
        // reste utile : on renvoie ces résultats plutôt que d'échouer.
        search::search_chunks(db, embedder.as_ref(), query, SEARCH_POOL)
            .await
            .unwrap_or_else(|error| {
                eprintln!("recherche sémantique indisponible : {error}");
                Vec::new()
            })
    };
    db.with_conn(|conn| repo::group_search(conn, query, &hits))
        .map_err(describe)
}

#[tauri::command]
pub async fn list_entities(
    state: State<'_, AppState>,
    kind: Option<EntityKind>,
    q: Option<String>,
) -> Result<Vec<EntitySummary>, String> {
    state
        .db
        .with_conn(|conn| repo::list_entity_summaries(conn, kind, q.as_deref()))
        .map_err(describe)
}

#[tauri::command]
pub async fn get_entity_card(state: State<'_, AppState>, id: String) -> Result<EntityCard, String> {
    state
        .db
        .with_conn(|conn| repo::entity_card(conn, &id))
        .map_err(describe)
}

#[tauri::command]
pub async fn set_fact_status(
    state: State<'_, AppState>,
    id: String,
    status: FactDecision,
) -> Result<Option<Fact>, String> {
    state
        .db
        .with_conn(|conn| repo::decide_fact(conn, &id, status))
        .map_err(describe)
}

#[tauri::command]
pub async fn add_entity_note(
    state: State<'_, AppState>,
    entity_id: String,
    text: String,
) -> Result<Item, String> {
    let item = state
        .db
        .with_conn(|conn| repo::add_entity_note(conn, &entity_id, &text))
        .map_err(describe)?;
    let _ = state.sidecar.call::<Value>("brain.run", json!({})).await;
    Ok(item)
}

#[tauri::command]
pub async fn update_entity(
    state: State<'_, AppState>,
    id: String,
    kind: Option<EntityKind>,
    tags: Option<Vec<String>>,
) -> Result<Entity, String> {
    state
        .db
        .with_conn(|conn| repo::update_entity(conn, &id, repo::EntityUpdate { kind, tags }))
        .map_err(describe)
}

#[tauri::command]
pub async fn global_search(
    state: State<'_, AppState>,
    q: String,
) -> Result<GlobalSearchResult, String> {
    global_search_in(&state.db, &q).await
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
}

pub fn register_host_methods(sidecar: &SidecarClient, db: Arc<Db>) {
    let handler: HostHandler = Arc::new(move |params| {
        let db = db.clone();
        Box::pin(async move {
            let params: SearchParams = serde_json::from_value(params)
                .map_err(|error| HostError::InvalidParams(error.to_string()))?;
            let result = global_search_in(&db, &params.q)
                .await
                .map_err(HostError::Internal)?;
            serde_json::to_value(result).map_err(|error| HostError::Internal(error.to_string()))
        })
    });
    sidecar.register_host_method("store.brain.search", handler);
}
