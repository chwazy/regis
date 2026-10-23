use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::Emitter;

use regis_core::sidecar::SidecarClient;

const READ_BUFFER_SIZE: usize = 8192;
const GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(50);
const DEFAULT_TERM: &str = "xterm-256color";

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("terminal session not found: {0}")]
    NotFound(String),
    #[error("terminal session already open: {0}")]
    AlreadyOpen(String),
    #[error("could not start the terminal process: {0}")]
    Spawn(String),
    #[error("terminal I/O error: {0}")]
    Io(String),
}

pub trait PtyEventSink: Send + Sync + 'static {
    fn data(&self, id: &str, base64_chunk: String);
    fn exit(&self, id: &str, code: Option<i32>, requested: bool);
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    process_id: Option<u32>,
    exited: Arc<AtomicBool>,
    close_requested: Arc<AtomicBool>,
}

type Sessions = Arc<Mutex<HashMap<String, PtySession>>>;

pub struct PtyManager {
    sink: Arc<dyn PtyEventSink>,
    sessions: Sessions,
}

fn lock(sessions: &Sessions) -> MutexGuard<'_, HashMap<String, PtySession>> {
    sessions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn io_error(error: impl std::fmt::Display) -> PtyError {
    PtyError::Io(error.to_string())
}

impl PtyManager {
    pub fn new(sink: Arc<dyn PtyEventSink>) -> PtyManager {
        PtyManager {
            sink,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &self,
        id: &str,
        program: &str,
        args: &[String],
        cwd: &Path,
        cols: u16,
        rows: u16,
        env: &[(String, String)],
    ) -> Result<(), PtyError> {
        if lock(&self.sessions).contains_key(id) {
            return Err(PtyError::AlreadyOpen(id.to_owned()));
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| PtyError::Spawn(error.to_string()))?;
        let mut command = CommandBuilder::new(program);
        command.args(args);
        command.cwd(cwd);
        // Un env non vide remplace tout l'environnement : les secrets de l'hôte restent hors des CLI d'agents.
        if !env.is_empty() {
            command.env_clear();
        }
        command.env("TERM", DEFAULT_TERM);
        for (name, value) in env {
            command.env(name, value);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| PtyError::Spawn(error.to_string()))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(io_error)?;
        let writer = pair.master.take_writer().map_err(io_error)?;
        let exited = Arc::new(AtomicBool::new(false));
        let close_requested = Arc::new(AtomicBool::new(false));
        lock(&self.sessions).insert(
            id.to_owned(),
            PtySession {
                master: pair.master,
                writer,
                killer: child.clone_killer(),
                process_id: child.process_id(),
                exited: exited.clone(),
                close_requested: close_requested.clone(),
            },
        );

        let reader_sink = self.sink.clone();
        let reader_id = id.to_owned();
        let reader_thread = thread::spawn(move || pump_output(reader, &*reader_sink, &reader_id));

        let waiter_sink = self.sink.clone();
        let waiter_sessions = self.sessions.clone();
        let waiter_id = id.to_owned();
        thread::spawn(move || {
            let code = child
                .wait()
                .ok()
                .and_then(|status| i32::try_from(status.exit_code()).ok());
            exited.store(true, Ordering::SeqCst);
            lock(&waiter_sessions).remove(&waiter_id);
            let _ = reader_thread.join();
            waiter_sink.exit(&waiter_id, code, close_requested.load(Ordering::SeqCst));
        });
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), PtyError> {
        let mut sessions = lock(&self.sessions);
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| PtyError::NotFound(id.to_owned()))?;
        session.writer.write_all(data).map_err(io_error)?;
        session.writer.flush().map_err(io_error)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        let sessions = lock(&self.sessions);
        let session = sessions
            .get(id)
            .ok_or_else(|| PtyError::NotFound(id.to_owned()))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(io_error)
    }

    pub fn close(&self, id: &str) -> Result<(), PtyError> {
        let (process_id, exited) = {
            let sessions = lock(&self.sessions);
            let session = sessions
                .get(id)
                .ok_or_else(|| PtyError::NotFound(id.to_owned()))?;
            session.close_requested.store(true, Ordering::SeqCst);
            (session.process_id, session.exited.clone())
        };
        if let Some(pid) = process_id {
            request_termination(pid);
        }
        let sessions = self.sessions.clone();
        let id = id.to_owned();
        thread::spawn(move || {
            let deadline = Instant::now() + GRACEFUL_CLOSE_TIMEOUT;
            while !exited.load(Ordering::SeqCst) && Instant::now() < deadline {
                thread::sleep(CLOSE_POLL_INTERVAL);
            }
            if !exited.load(Ordering::SeqCst) {
                if let Some(session) = lock(&sessions).get_mut(&id) {
                    let _ = session.killer.kill();
                }
            }
        });
        Ok(())
    }

    pub fn process_id(&self, id: &str) -> Option<u32> {
        lock(&self.sessions).get(id).and_then(|s| s.process_id)
    }

    pub fn is_open(&self, id: &str) -> bool {
        lock(&self.sessions).contains_key(id)
    }
}

fn pump_output(mut reader: Box<dyn Read + Send>, sink: &dyn PtyEventSink, id: &str) {
    let mut buffer = [0_u8; READ_BUFFER_SIZE];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(length) => sink.data(id, STANDARD.encode(&buffer[..length])),
        }
    }
}

#[cfg(unix)]
fn request_termination(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-TERM", "--", &format!("-{pid}")])
        .status();
}

#[cfg(not(unix))]
fn request_termination(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

pub struct TauriPtySink {
    pub app: tauri::AppHandle,
    pub sidecar: SidecarClient,
}

impl PtyEventSink for TauriPtySink {
    fn data(&self, id: &str, base64_chunk: String) {
        let _ = self.app.emit(&format!("pty://{id}/data"), base64_chunk);
    }

    fn exit(&self, id: &str, code: Option<i32>, requested: bool) {
        let app = self.app.clone();
        let sidecar = self.sidecar.clone();
        let id = id.to_owned();
        tauri::async_runtime::spawn(async move {
            let _ = sidecar
                .call::<serde_json::Value>(
                    "jobs.endPty",
                    serde_json::json!({ "jobId": id, "code": code, "requested": requested }),
                )
                .await;
            let _ = app.emit(
                &format!("pty://{id}/exit"),
                serde_json::json!({ "code": code }),
            );
        });
    }
}

#[cfg(test)]
mod tests;
