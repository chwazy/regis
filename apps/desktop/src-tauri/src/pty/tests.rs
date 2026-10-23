use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use super::{PtyEventSink, PtyManager};

type ExitReport = (Option<i32>, bool);

struct CollectingSink {
    output: Mutex<Vec<u8>>,
    exits: Mutex<Sender<ExitReport>>,
}

impl PtyEventSink for CollectingSink {
    fn data(&self, _id: &str, base64_chunk: String) {
        let bytes = STANDARD.decode(base64_chunk).expect("valid base64");
        self.output.lock().expect("output lock").extend(bytes);
    }

    fn exit(&self, _id: &str, code: Option<i32>, requested: bool) {
        let _ = self
            .exits
            .lock()
            .expect("exit lock")
            .send((code, requested));
    }
}

fn manager() -> (PtyManager, Arc<CollectingSink>, Receiver<ExitReport>) {
    let (sender, receiver) = channel();
    let sink = Arc::new(CollectingSink {
        output: Mutex::new(Vec::new()),
        exits: Mutex::new(sender),
    });
    (PtyManager::new(sink.clone()), sink, receiver)
}

fn shell() -> &'static str {
    if cfg!(windows) {
        "cmd.exe"
    } else {
        "sh"
    }
}

fn process_exists(pid: u32) -> bool {
    if cfg!(windows) {
        let listing = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&listing.stdout)
            .split_whitespace()
            .any(|token| token == pid.to_string())
    } else {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn working_directory() -> std::path::PathBuf {
    std::env::temp_dir()
}

#[test]
fn echo_roundtrip() {
    let (manager, sink, exits) = manager();
    manager
        .open("echo", shell(), &[], &working_directory(), 80, 24, &[])
        .expect("open");
    manager
        .write("echo", b"echo REGIS_PTY_OK\r")
        .expect("write");
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut seen = false;
    let mut answered_cursor_query = false;
    while Instant::now() < deadline && !seen {
        let output = sink.output.lock().expect("output lock").clone();
        if !answered_cursor_query && String::from_utf8_lossy(&output).contains("\x1b[6n") {
            answered_cursor_query = true;
            manager
                .write("echo", b"\x1b[1;1R")
                .expect("answer cursor query");
        }
        seen = String::from_utf8_lossy(&output).contains("REGIS_PTY_OK");
        std::thread::sleep(Duration::from_millis(50));
    }
    manager.close("echo").expect("close");
    let _ = exits.recv_timeout(Duration::from_secs(5));
    assert!(
        seen,
        "REGIS_PTY_OK not received within 3 seconds: {:?}",
        String::from_utf8_lossy(&sink.output.lock().expect("output lock"))
    );
}

#[test]
fn close_kills_process() {
    let (manager, _sink, exits) = manager();
    manager
        .open("close", shell(), &[], &working_directory(), 80, 24, &[])
        .expect("open");
    let pid = manager.process_id("close").expect("process id");
    assert!(process_exists(pid));
    manager.close("close").expect("close");
    let exit = exits.recv_timeout(Duration::from_secs(4));
    assert!(exit.is_ok(), "exit event not emitted within 4 seconds");
    let deadline = Instant::now() + Duration::from_secs(4);
    while process_exists(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!process_exists(pid), "process still running after close");
    assert!(!manager.is_open("close"));
}

#[test]
fn unknown_session_is_reported() {
    let (manager, _sink, _exits) = manager();
    assert!(manager.write("missing", b"x").is_err());
    assert!(manager.resize("missing", 80, 24).is_err());
    assert!(manager.close("missing").is_err());
}

#[test]
fn resize_reaches_the_terminal() {
    let (manager, _sink, exits) = manager();
    manager
        .open("resize", shell(), &[], &working_directory(), 80, 24, &[])
        .expect("open");
    assert!(manager.resize("resize", 100, 30).is_ok());
    manager.close("resize").expect("close");
    let _ = exits.recv_timeout(Duration::from_secs(5));
}

fn exiting_shell_args() -> Vec<String> {
    let flag = if cfg!(windows) { "/C" } else { "-c" };
    vec![flag.to_owned(), "exit 0".to_owned()]
}

#[test]
fn close_reports_exit_as_requested() {
    let (manager, _sink, exits) = manager();
    manager
        .open("requested", shell(), &[], &working_directory(), 80, 24, &[])
        .expect("open");
    manager.close("requested").expect("close");
    let (_, requested) = exits
        .recv_timeout(Duration::from_secs(5))
        .expect("exit event");
    assert!(requested);
}

#[test]
fn natural_exit_is_not_reported_as_requested() {
    let (manager, _sink, exits) = manager();
    manager
        .open(
            "natural",
            shell(),
            &exiting_shell_args(),
            &working_directory(),
            80,
            24,
            &[],
        )
        .expect("open");
    let _ = manager.write("natural", b"[1;1R");
    let (code, requested) = exits
        .recv_timeout(Duration::from_secs(5))
        .expect("exit event");
    assert_eq!(code, Some(0));
    assert!(!requested);
}
