use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::Deserialize;

use super::{is_enabled, LocalModuleId, ModelState, ModuleError};
use crate::db::Db;
use crate::files::embed::OllamaEmbedder;
use crate::files::indexer::load_embedder;

pub const BGE_M3_MODEL: &str = "bge-m3";

const STATE_CACHE_TTL: Duration = Duration::from_secs(30);
const TAGS_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const TAGS_TIMEOUT: Duration = Duration::from_secs(4);
const PULL_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullProgress {
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct PullLine {
    status: Option<String>,
    completed: Option<u64>,
    total: Option<u64>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<TagsModel>,
}

#[derive(Deserialize)]
struct TagsModel {
    name: String,
}

pub fn has_model(models: &[String], name: &str) -> bool {
    models
        .iter()
        .any(|model| model == name || model.starts_with(&format!("{name}:")))
}

pub fn parse_pull_line(line: &str) -> Option<PullProgress> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed: PullLine = serde_json::from_str(trimmed).ok()?;
    let status = parsed.status.unwrap_or_default();
    Some(PullProgress {
        done: status == "success",
        status,
        completed: parsed.completed,
        total: parsed.total,
        error: parsed.error,
    })
}

type StateCache = Mutex<HashMap<String, (Instant, ModelState)>>;

fn state_cache() -> &'static StateCache {
    static CACHE: OnceLock<StateCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

pub fn invalidate_state_cache() {
    if let Ok(mut cache) = state_cache().lock() {
        cache.clear();
    }
}

fn cached_state(url: &str) -> Option<ModelState> {
    let cache = state_cache().lock().ok()?;
    cache
        .get(url)
        .filter(|(at, _)| at.elapsed() < STATE_CACHE_TTL)
        .map(|(_, state)| *state)
}

async fn query_state(url: &str) -> ModelState {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(TAGS_CONNECT_TIMEOUT)
        .timeout(TAGS_TIMEOUT)
        .build()
    else {
        return ModelState::Unreachable;
    };
    let endpoint = format!("{}/api/tags", url.trim_end_matches('/'));
    let Ok(response) = client.get(endpoint).send().await else {
        return ModelState::Unreachable;
    };
    if !response.status().is_success() {
        return ModelState::Unreachable;
    }
    let Ok(tags) = response.json::<TagsResponse>().await else {
        return ModelState::Unreachable;
    };
    let names: Vec<String> = tags.models.into_iter().map(|model| model.name).collect();
    if has_model(&names, BGE_M3_MODEL) {
        ModelState::Ready
    } else {
        ModelState::Missing
    }
}

pub async fn model_state(url: &str, force: bool) -> ModelState {
    if !force {
        if let Some(state) = cached_state(url) {
            return state;
        }
    }
    let state = query_state(url).await;
    if let Ok(mut cache) = state_cache().lock() {
        cache.insert(url.to_owned(), (Instant::now(), state));
    }
    state
}

/// `None` tant que le module n'est pas à l'état `on` : aucune requête vers Ollama dans ce cas.
pub async fn active_embedder(db: &Db) -> Option<OllamaEmbedder> {
    if crate::demo::is_enabled() || !is_enabled(db, LocalModuleId::Embeddings) {
        return None;
    }
    let embedder = load_embedder(db);
    (model_state(&embedder.url, false).await == ModelState::Ready).then_some(embedder)
}

pub async fn pull_model(
    url: &str,
    model: &str,
    mut on_progress: impl FnMut(&PullProgress),
) -> Result<(), ModuleError> {
    if model != BGE_M3_MODEL {
        return Err(ModuleError::Download(format!(
            "modèle non autorisé : {model}"
        )));
    }
    let download_error = |error: &dyn std::fmt::Display| ModuleError::Download(error.to_string());
    let client = reqwest::Client::builder()
        .connect_timeout(PULL_CONNECT_TIMEOUT)
        .build()
        .map_err(|error| download_error(&error))?;
    let response = client
        .post(format!("{}/api/pull", url.trim_end_matches('/')))
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|error| {
            if error.is_connect() || error.is_timeout() {
                ModuleError::OllamaUnreachable
            } else {
                download_error(&error)
            }
        })?;
    if !response.status().is_success() {
        return Err(ModuleError::Download(format!(
            "Ollama a répondu {}",
            response.status()
        )));
    }
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut succeeded = false;
    let mut handle_line = |line: &[u8]| -> Result<(), ModuleError> {
        let Some(progress) = parse_pull_line(&String::from_utf8_lossy(line)) else {
            return Ok(());
        };
        if let Some(message) = &progress.error {
            return Err(ModuleError::Download(message.clone()));
        }
        succeeded |= progress.done;
        on_progress(&progress);
        Ok(())
    };
    while let Some(chunk) = stream.next().await {
        buffer.extend_from_slice(&chunk.map_err(|error| download_error(&error))?);
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=newline).collect();
            handle_line(&line)?;
        }
    }
    handle_line(&buffer)?;
    if succeeded {
        Ok(())
    } else {
        Err(ModuleError::Download(
            "le téléchargement s'est interrompu".to_owned(),
        ))
    }
}

pub async fn pull_bge_m3(
    url: &str,
    on_progress: impl FnMut(&PullProgress),
) -> Result<(), ModuleError> {
    pull_model(url, BGE_M3_MODEL, on_progress).await
}

#[cfg(any(test, feature = "test-util"))]
pub mod testing {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    pub struct FakeOllama {
        pub url: String,
        pub pulls: Arc<AtomicUsize>,
        pub tags_requests: Arc<AtomicUsize>,
    }

    /// `models` : noms listés par `/api/tags` ; `pull_body` : réponse NDJSON de `/api/pull`.
    pub fn start(models: &[&str], pull_body: &str) -> FakeOllama {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake ollama");
        let url = format!("http://{}", listener.local_addr().expect("address"));
        let pulls = Arc::new(AtomicUsize::new(0));
        let tags_requests = Arc::new(AtomicUsize::new(0));
        let tags_body = serde_json::json!({
            "models": models.iter().map(|name| serde_json::json!({ "name": name })).collect::<Vec<_>>()
        })
        .to_string();
        let pull_body = pull_body.to_owned();
        let (pull_counter, tags_counter) = (pulls.clone(), tags_requests.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                let mut content_length = 0_usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0_u8; content_length];
                let _ = reader.read_exact(&mut body);
                let payload = if request_line.starts_with("POST /api/pull") {
                    pull_counter.fetch_add(1, Ordering::SeqCst);
                    pull_body.clone()
                } else {
                    tags_counter.fetch_add(1, Ordering::SeqCst);
                    tags_body.clone()
                };
                let mut writer = stream;
                let _ = write!(
                    writer,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
            }
        });
        FakeOllama {
            url,
            pulls,
            tags_requests,
        }
    }

    pub fn unreachable_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("address"));
        drop(listener);
        url
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::testing::{start, unreachable_url};
    use super::*;

    #[test]
    fn has_model_matches_exact_name_or_tag_prefix() {
        assert!(has_model(&["bge-m3:latest".to_owned()], "bge-m3"));
        assert!(has_model(&["bge-m3".to_owned()], "bge-m3"));
        assert!(!has_model(&["llama3".to_owned()], "bge-m3"));
        assert!(!has_model(&["bge-m3-large:1".to_owned()], "bge-m3"));
    }

    #[test]
    fn pull_lines_are_parsed() {
        let progress =
            parse_pull_line(r#"{"status":"pulling","completed":5,"total":10}"#).expect("progress");
        assert_eq!(progress.completed, Some(5));
        assert_eq!(progress.total, Some(10));
        assert!(!progress.done);
        assert!(
            parse_pull_line(r#"{"status":"success"}"#)
                .expect("done")
                .done
        );
        let failed = parse_pull_line(r#"{"error":"boom"}"#).expect("error");
        assert_eq!(failed.error.as_deref(), Some("boom"));
        assert_eq!(parse_pull_line("pas du json"), None);
        assert_eq!(parse_pull_line("   "), None);
    }

    #[tokio::test]
    async fn model_state_distinguishes_ready_missing_and_unreachable() {
        let ready = start(&["bge-m3:latest"], "");
        assert_eq!(model_state(&ready.url, true).await, ModelState::Ready);
        let missing = start(&["llama3"], "");
        assert_eq!(model_state(&missing.url, true).await, ModelState::Missing);
        assert_eq!(
            model_state(&unreachable_url(), true).await,
            ModelState::Unreachable
        );
    }

    #[tokio::test]
    async fn model_state_is_cached_between_calls() {
        let fake = start(&["bge-m3"], "");
        model_state(&fake.url, false).await;
        model_state(&fake.url, false).await;
        assert_eq!(fake.tags_requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn pull_reports_progress_until_success() {
        let body = "{\"status\":\"pulling manifest\"}\n{\"status\":\"pulling abc\",\"completed\":5,\"total\":10}\n{\"status\":\"success\"}\n";
        let fake = start(&[], body);
        let mut seen = Vec::new();
        pull_bge_m3(&fake.url, |progress| seen.push(progress.clone()))
            .await
            .expect("pull");
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[1].total, Some(10));
        assert!(seen[2].done);
    }

    #[tokio::test]
    async fn pull_error_line_fails_the_pull() {
        let fake = start(&[], "{\"error\":\"boom\"}\n");
        let error = pull_bge_m3(&fake.url, |_| {}).await.expect_err("failure");
        assert!(error.to_string().contains("boom"));
    }

    #[tokio::test]
    async fn pull_of_another_model_is_refused_without_a_request() {
        let fake = start(&[], "{\"status\":\"success\"}\n");
        let error = pull_model(&fake.url, "llama3", |_| {})
            .await
            .expect_err("refused");
        assert!(matches!(error, ModuleError::Download(_)));
        assert_eq!(fake.pulls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn pull_on_unreachable_server_reports_ollama_unreachable() {
        let error = pull_bge_m3(&unreachable_url(), |_| {})
            .await
            .expect_err("unreachable");
        assert!(matches!(error, ModuleError::OllamaUnreachable));
    }
}
