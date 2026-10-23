use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

pub const CALL_TIMEOUT: Duration = Duration::from_secs(10);
const RESTART_DELAY: Duration = Duration::from_millis(500);
const EVENT_METHOD: &str = "event";
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

pub type HostHandler =
    Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value, HostError>> + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("sidecar is not running")]
    NotRunning,
    #[error("sidecar call timed out")]
    Timeout,
    #[error("sidecar error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("sidecar io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid sidecar payload: {0}")]
    Payload(String),
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("invalid params: {0}")]
    InvalidParams(String),
    #[error("{0}")]
    Internal(String),
}

impl HostError {
    fn code(&self) -> i64 {
        match self {
            HostError::InvalidParams(_) => INVALID_PARAMS,
            HostError::Internal(_) => INTERNAL_ERROR,
        }
    }
}

pub trait SidecarObserver: Send + Sync + 'static {
    fn on_event(&self, event: Value);
    fn on_status(&self, state: &str);
}

#[derive(Clone, Debug)]
pub struct LaunchSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub current_dir: Option<PathBuf>,
    pub env: Vec<(OsString, OsString)>,
}

type PendingReply = oneshot::Sender<Result<Value, SidecarError>>;

struct Inner {
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, PendingReply>>,
    handlers: Mutex<HashMap<&'static str, HostHandler>>,
    next_id: AtomicU64,
}

#[derive(Clone)]
pub struct SidecarClient {
    inner: Arc<Inner>,
}

impl Default for SidecarClient {
    fn default() -> Self {
        Self::new()
    }
}

impl SidecarClient {
    pub fn new() -> SidecarClient {
        SidecarClient {
            inner: Arc::new(Inner {
                stdin: AsyncMutex::new(None),
                pending: Mutex::new(HashMap::new()),
                handlers: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn register_host_method(&self, method: &'static str, handler: HostHandler) {
        lock(&self.inner.handlers).insert(method, handler);
    }

    pub async fn call<R: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<R, SidecarError> {
        self.call_with_timeout(method, params, CALL_TIMEOUT).await
    }

    pub async fn call_with_timeout<R: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<R, SidecarError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = oneshot::channel();
        lock(&self.inner.pending).insert(id, reply_tx);
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(error) = self.write_line(&request).await {
            lock(&self.inner.pending).remove(&id);
            return Err(error);
        }
        let reply = match tokio::time::timeout(timeout, reply_rx).await {
            Err(_) => {
                lock(&self.inner.pending).remove(&id);
                return Err(SidecarError::Timeout);
            }
            Ok(Err(_)) => return Err(SidecarError::NotRunning),
            Ok(Ok(reply)) => reply?,
        };
        serde_json::from_value(reply).map_err(|error| SidecarError::Payload(error.to_string()))
    }

    pub async fn supervise(self, spec: LaunchSpec, observer: Arc<dyn SidecarObserver>) {
        let mut has_started = false;
        loop {
            match self.run_once(&spec, &observer, has_started).await {
                Ok(()) => has_started = true,
                Err(error) => eprintln!("[sidecar] failed to run: {error}"),
            }
            tokio::time::sleep(RESTART_DELAY).await;
        }
    }

    async fn run_once(
        &self,
        spec: &LaunchSpec,
        observer: &Arc<dyn SidecarObserver>,
        is_restart: bool,
    ) -> Result<(), SidecarError> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.envs(spec.env.iter().map(|(key, value)| (key, value)));
        if let Some(dir) = &spec.current_dir {
            command.current_dir(dir);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn()?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(SidecarError::NotRunning);
        };
        *self.inner.stdin.lock().await = Some(stdin);
        observer.on_status(if is_restart { "restarted" } else { "started" });

        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[sidecar] {line}");
            }
        });
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            self.dispatch_line(&line, observer);
        }
        let _ = child.wait().await;
        stderr_task.abort();

        *self.inner.stdin.lock().await = None;
        self.fail_pending();
        observer.on_status("stopped");
        Ok(())
    }

    fn dispatch_line(&self, line: &str, observer: &Arc<dyn SidecarObserver>) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            eprintln!("[sidecar] non-JSON line on stdout: {line}");
            return;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (
            message.get("method").and_then(Value::as_str),
            message.get("id"),
        ) {
            (Some(method), Some(id)) => {
                let client = self.clone();
                let method = method.to_owned();
                let id = id.clone();
                tokio::spawn(async move { client.answer_host_request(id, &method, params).await });
            }
            (Some(EVENT_METHOD), None) => observer.on_event(params),
            (Some(_), None) => {}
            (None, Some(id)) => self.resolve_pending(id, &message),
            (None, None) => eprintln!("[sidecar] unrecognised message: {line}"),
        }
    }

    fn resolve_pending(&self, id: &Value, message: &Value) {
        let Some(reply_tx) = id
            .as_u64()
            .and_then(|id| lock(&self.inner.pending).remove(&id))
        else {
            return;
        };
        let reply = match message.get("error") {
            Some(error) => Err(SidecarError::Rpc {
                code: error
                    .get("code")
                    .and_then(Value::as_i64)
                    .unwrap_or(INTERNAL_ERROR),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            }),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = reply_tx.send(reply);
    }

    async fn answer_host_request(&self, id: Value, method: &str, params: Value) {
        let handler = lock(&self.inner.handlers).get(method).cloned();
        let response = match handler {
            None => error_response(
                &id,
                METHOD_NOT_FOUND,
                &format!("Method not found: {method}"),
            ),
            Some(handler) => match handler(params).await {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err(error) => error_response(&id, error.code(), &error.to_string()),
            },
        };
        if let Err(error) = self.write_line(&response).await {
            eprintln!("[sidecar] could not answer {method}: {error}");
        }
    }

    async fn write_line(&self, message: &Value) -> Result<(), SidecarError> {
        let mut line = message.to_string();
        line.push('\n');
        let mut guard = self.inner.stdin.lock().await;
        let stdin = guard.as_mut().ok_or(SidecarError::NotRunning)?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    fn fail_pending(&self) {
        let drained: Vec<PendingReply> = lock(&self.inner.pending)
            .drain()
            .map(|(_, tx)| tx)
            .collect();
        for reply_tx in drained {
            let _ = reply_tx.send(Err(SidecarError::NotRunning));
        }
    }
}

fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingObserver {
        statuses: Mutex<Vec<String>>,
    }

    impl SidecarObserver for RecordingObserver {
        fn on_event(&self, _event: Value) {}

        fn on_status(&self, state: &str) {
            lock(&self.statuses).push(state.to_owned());
        }
    }

    fn fake_sidecar_spec() -> LaunchSpec {
        LaunchSpec {
            program: "node".into(),
            args: vec![concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fake-sidecar.mjs").into()],
            current_dir: None,
            env: Vec::new(),
        }
    }

    async fn call_when_ready(client: &SidecarClient, method: &str) -> Result<Value, SidecarError> {
        for _ in 0..100 {
            match client.call::<Value>(method, Value::Null).await {
                Err(SidecarError::NotRunning | SidecarError::Io(_)) => {
                    tokio::time::sleep(Duration::from_millis(50)).await
                }
                other => return other,
            }
        }
        Err(SidecarError::NotRunning)
    }

    #[tokio::test]
    async fn roundtrip_with_fake_sidecar() {
        let client = SidecarClient::new();
        client.register_host_method(
            "host.ping",
            Arc::new(|_params| Box::pin(async { Ok(json!({ "ok": true })) })),
        );
        let observer = Arc::new(RecordingObserver::default());
        let supervisor = tokio::spawn(client.clone().supervise(fake_sidecar_spec(), observer));

        let ping = call_when_ready(&client, "system.ping").await.expect("ping");
        supervisor.abort();

        assert_eq!(ping["name"], "regis-sidecar");
        assert_eq!(ping["hostReply"], json!({ "ok": true }));
    }

    #[tokio::test]
    async fn restarts_after_the_process_exits() {
        let client = SidecarClient::new();
        let observer = Arc::new(RecordingObserver::default());
        let supervisor = tokio::spawn(
            client
                .clone()
                .supervise(fake_sidecar_spec(), observer.clone()),
        );

        call_when_ready(&client, "system.ping")
            .await
            .expect("first ping");
        let _ = client.call::<Value>("system.exit", Value::Null).await;
        let ping = call_when_ready(&client, "system.ping")
            .await
            .expect("ping after restart");
        supervisor.abort();

        assert_eq!(ping["name"], "regis-sidecar");
        let statuses = lock(&observer.statuses).clone();
        assert_eq!(statuses, ["started", "stopped", "restarted"]);
    }
}
