use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use bytes::Bytes;
use futures::channel::mpsc;
use futures::StreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderValue, CACHE_CONTROL, CONTENT_TYPE, ORIGIN};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, EventId, Listener, Manager};
use tokio::net::TcpListener;

use crate::commands::{
    self, audio, brain, dashboard, data, files, meetings, modules, pty, recording, settings,
    templates,
};
use crate::AppState;

const PORT_ENV: &str = "REGIS_DEV_BRIDGE_PORT";
const TOKEN_ENV: &str = "REGIS_DEV_BRIDGE_TOKEN";
const TOKEN_HEADER: &str = "x-regis-bridge-token";

type BridgeBody = BoxBody<Bytes, Infallible>;

#[derive(Debug, thiserror::Error)]
pub enum DevBridgeError {
    #[error("{PORT_ENV} is not a valid port: {0}")]
    InvalidPort(String),
    #[error("cannot listen on 127.0.0.1:{port}: {source}")]
    Bind { port: u16, source: std::io::Error },
}

#[derive(Debug, PartialEq)]
struct BridgeConfig {
    port: u16,
    token: String,
}

impl BridgeConfig {
    fn from_values(
        port: Option<String>,
        token: Option<String>,
    ) -> Result<Option<Self>, DevBridgeError> {
        let (Some(port), Some(token)) = (port, token) else {
            return Ok(None);
        };
        if token.is_empty() {
            return Ok(None);
        }
        let port = port
            .parse::<u16>()
            .map_err(|_| DevBridgeError::InvalidPort(port.clone()))?;
        Ok(Some(BridgeConfig { port, token }))
    }
}

#[derive(Deserialize)]
struct InvokeRequest {
    cmd: String,
    #[serde(default)]
    args: Map<String, Value>,
}

macro_rules! bridge_commands {
    ($( $kind:ident $command:path => ( $($param:ident),* ) ),* $(,)?) => {
        #[cfg(test)]
        fn command_names() -> Vec<&'static str> {
            vec![$( command_name(stringify!($command)) ),*]
        }

        async fn dispatch(app: &AppHandle, cmd: &str, args: Map<String, Value>) -> Result<Value, String> {
            $(
                if cmd == command_name(stringify!($command)) {
                    return bridge_commands!(@call $kind app, args, $command, ($($param),*));
                }
            )*
            Err(format!("unknown command {cmd}"))
        }
    };
    (@call state $app:ident, $args:ident, $command:path, ($($param:ident),*)) => {
        encode($command($app.state::<AppState>(), $(arg(&$args, stringify!($param))?),*).await)
    };
    (@call sync_state $app:ident, $args:ident, $command:path, ($($param:ident),*)) => {
        encode($command($app.state::<AppState>(), $(arg(&$args, stringify!($param))?),*))
    };
    (@call app_state $app:ident, $args:ident, $command:path, ($($param:ident),*)) => {
        encode($command($app.clone(), $app.state::<AppState>(), $(arg(&$args, stringify!($param))?),*).await)
    };
    (@call stateless $app:ident, $args:ident, $command:path, ($($param:ident),*)) => {
        encode($command($(arg(&$args, stringify!($param))?),*).await)
    };
}

bridge_commands! {
    state commands::app_info => (),
    state commands::sidecar_call => (method, params, timeout_secs),
    state data::list_jobs => (status, limit),
    state data::get_job => (id),
    state data::list_job_events => (job_id),
    state data::list_approvals => (status),
    state data::resolve_approval => (id, status, decision_note, edited_input),
    state data::list_agents => (),
    state data::save_agent => (agent),
    state data::delete_agent => (id),
    state data::list_connectors => (),
    state data::save_connector => (connector),
    state data::delete_connector => (id),
    state data::list_policies => (),
    state data::save_policy => (policy),
    state data::list_rules => (),
    state data::save_rules => (rules),
    stateless data::set_secret => (secret_ref, value),
    stateless data::delete_secret => (secret_ref),
    state data::get_setting => (key),
    state data::set_setting => (key, value),
    state settings::get_app_info => (),
    app_state settings::set_data_dir => (path, resume_url),
    state files::list_file_sources => (),
    state files::add_file_source => (kind, path, watch_mode, poll_minutes),
    state files::remove_file_source => (id),
    state files::rescan_source => (id),
    state files::import_files => (paths),
    state files::import_clipboard_image => (png_base64),
    state files::list_files => (role, status, unlinked_only),
    state files::link_file => (file_id, entity_id, rel),
    state files::list_linkable_entities => (),
    state files::search => (query, k),
    state templates::list_templates => (),
    state templates::update_template => (id, patch),
    state templates::import_template => (path),
    state templates::open_template => (id),
    sync_state pty::pty_write => (id, data),
    sync_state pty::pty_resize => (id, cols, rows),
    sync_state pty::pty_close => (id),
    state brain::list_entities => (kind, q),
    state brain::get_entity_card => (id),
    state brain::set_fact_status => (id, status),
    state brain::add_entity_note => (entity_id, text),
    state brain::update_entity => (id, kind, tags),
    state brain::global_search => (q),
    state dashboard::list_dashboards => (),
    state dashboard::save_dashboard => (dashboard),
    state dashboard::delete_dashboard => (id),
    state dashboard::list_widgets => (dashboard_id),
    state dashboard::save_widgets => (dashboard_id, widgets),
    state dashboard::delete_widget => (id),
    state dashboard::widget_data => (kind, config),
    stateless audio::audio_list_devices => (),
    state audio::audio_test_level => (source, duration_ms),
    state audio::stt_status => (),
    state audio::stt_download_model => (model_id),
    state audio::dictation_start => (),
    state audio::dictation_stop => (session_id),
    state audio::dictation_cancel => (session_id),
    state modules::modules_status => (refresh),
    state modules::module_enable => (id),
    state modules::module_disable => (id),
    state modules::module_delete_model => (id),
    app_state meetings::open_meeting => (item_id),
    state recording::recording_start => (input),
    state recording::recording_stop => (id),
    state recording::recording_active => (),
    state recording::recording_get => (transcript_item_id),
    state recording::recording_delete_audio => (id),
    state recording::minutes_get => (transcript_item_id),
    state recording::minutes_generate => (transcript_item_id),
    state recording::minutes_export => (minutes_item_id, template_id),
}

fn command_name(command_path: &'static str) -> &'static str {
    command_path
        .rsplit("::")
        .next()
        .unwrap_or(command_path)
        .trim()
}

fn camel_case(snake: &str) -> String {
    let mut camel = String::with_capacity(snake.len());
    let mut upper_next = false;
    for character in snake.chars() {
        if character == '_' {
            upper_next = true;
        } else if upper_next {
            camel.extend(character.to_uppercase());
            upper_next = false;
        } else {
            camel.push(character);
        }
    }
    camel
}

fn arg<T: DeserializeOwned>(args: &Map<String, Value>, param: &str) -> Result<T, String> {
    let key = camel_case(param);
    let value = args.get(&key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|error| format!("invalid argument {key}: {error}"))
}

fn encode<T: Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value))?
    })
}

fn percent_decode(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let hex = encoded.get(index + 1..index + 3)?;
                decoded.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).ok()
}

fn is_local_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some(authority) = origin.strip_prefix("http://") else {
        return false;
    };
    let host = authority
        .rsplit_once(':')
        .map_or(authority, |(host, _)| host);
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

fn sse_frame(payload: &str) -> Bytes {
    Bytes::from(format!("data: {payload}\n\n"))
}

fn full(
    status: StatusCode,
    content_type: &'static str,
    body: impl Into<Bytes>,
) -> Response<BridgeBody> {
    let mut response = Response::new(Full::new(body.into()).boxed());
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}

fn json_response(status: StatusCode, value: &Value) -> Response<BridgeBody> {
    full(status, "application/json", value.to_string())
}

struct ListenerGuard {
    app: AppHandle,
    id: EventId,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        self.app.unlisten(self.id);
    }
}

fn event_stream(app: &AppHandle, event: String) -> Response<BridgeBody> {
    let (sender, receiver) = mpsc::unbounded::<Result<Frame<Bytes>, Infallible>>();
    let _ = sender.unbounded_send(Ok(Frame::data(Bytes::from_static(b": connected\n\n"))));
    let id = app.listen_any(event, move |event| {
        let _ = sender.unbounded_send(Ok(Frame::data(sse_frame(event.payload()))));
    });
    let guard = ListenerGuard {
        app: app.clone(),
        id,
    };
    let frames = receiver.map(move |frame| {
        let _ = &guard;
        frame
    });
    let mut response = Response::new(BodyExt::boxed(StreamBody::new(frames)));
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

async fn handle(
    app: AppHandle,
    token: Arc<str>,
    request: Request<Incoming>,
) -> Result<Response<BridgeBody>, Infallible> {
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|value: &HeaderValue| value.to_str().ok())
    };
    let authorized = header(TOKEN_HEADER).is_some_and(|value| value == &*token);
    if !authorized || !is_local_origin(header(ORIGIN.as_str())) {
        return Ok(full(StatusCode::UNAUTHORIZED, "text/plain", "unauthorized"));
    }
    let is_json =
        header(CONTENT_TYPE.as_str()).is_some_and(|value| value.starts_with("application/json"));
    let response = match (request.method(), request.uri().path()) {
        (&Method::POST, "/invoke") if !is_json => full(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "text/plain",
            "expected application/json",
        ),
        (&Method::POST, "/invoke") => {
            let body = match request.into_body().collect().await {
                Ok(collected) => collected.to_bytes(),
                Err(error) => {
                    return Ok(json_response(
                        StatusCode::BAD_REQUEST,
                        &Value::String(error.to_string()),
                    ))
                }
            };
            match serde_json::from_slice::<InvokeRequest>(&body) {
                Ok(invoke) => match dispatch(&app, &invoke.cmd, invoke.args).await {
                    Ok(value) => json_response(StatusCode::OK, &value),
                    Err(error) => {
                        json_response(StatusCode::INTERNAL_SERVER_ERROR, &Value::String(error))
                    }
                },
                Err(error) => {
                    json_response(StatusCode::BAD_REQUEST, &Value::String(error.to_string()))
                }
            }
        }
        (&Method::GET, "/events") => {
            match request
                .uri()
                .query()
                .and_then(|query| query_param(query, "event"))
            {
                Some(event) => event_stream(&app, event),
                None => full(StatusCode::BAD_REQUEST, "text/plain", "missing event"),
            }
        }
        _ => full(StatusCode::NOT_FOUND, "text/plain", "not found"),
    };
    Ok(response)
}

async fn serve(app: AppHandle, config: BridgeConfig) -> Result<(), DevBridgeError> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, config.port));
    let listener = TcpListener::bind(address)
        .await
        .map_err(|source| DevBridgeError::Bind {
            port: config.port,
            source,
        })?;
    eprintln!("[dev-bridge] listening on {address}");
    let token: Arc<str> = config.token.into();
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let app = app.clone();
        let token = token.clone();
        tauri::async_runtime::spawn(async move {
            let service = service_fn(move |request| handle(app.clone(), token.clone(), request));
            if let Err(error) = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await
            {
                eprintln!("[dev-bridge] connection error: {error}");
            }
        });
    }
}

pub fn spawn(app: AppHandle) {
    let config = match BridgeConfig::from_values(
        std::env::var(PORT_ENV).ok(),
        std::env::var(TOKEN_ENV).ok(),
    ) {
        Ok(Some(config)) => config,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[dev-bridge] disabled: {error}");
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(app, config).await {
            eprintln!("[dev-bridge] stopped: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bridge_covers_every_registered_command() {
        let source = include_str!("lib.rs");
        let start =
            source.find("generate_handler![").expect("handler list") + "generate_handler![".len();
        let end = start + source[start..].find(']').expect("handler list end");
        let mut registered: Vec<&str> = source[start..end]
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(|entry| entry.rsplit("::").next().unwrap_or(entry))
            .collect();
        let mut bridged = command_names();
        registered.sort_unstable();
        bridged.sort_unstable();
        assert_eq!(bridged, registered);
    }

    #[test]
    fn config_requires_both_port_and_token() {
        assert_eq!(
            BridgeConfig::from_values(None, Some("t".into())).unwrap(),
            None
        );
        assert_eq!(
            BridgeConfig::from_values(Some("1430".into()), None).unwrap(),
            None
        );
        assert_eq!(
            BridgeConfig::from_values(Some("1430".into()), Some(String::new())).unwrap(),
            None
        );
        assert_eq!(
            BridgeConfig::from_values(Some("1430".into()), Some("t".into())).unwrap(),
            Some(BridgeConfig {
                port: 1430,
                token: "t".into()
            })
        );
        assert!(BridgeConfig::from_values(Some("nope".into()), Some("t".into())).is_err());
    }

    #[test]
    fn args_are_read_by_camel_case_name() {
        let args = json!({ "timeoutSecs": 5, "secretRef": "odoo" });
        let args = args.as_object().unwrap();
        assert_eq!(arg::<Option<u64>>(args, "timeout_secs").unwrap(), Some(5));
        assert_eq!(arg::<String>(args, "secret_ref").unwrap(), "odoo");
        assert_eq!(arg::<Option<String>>(args, "missing").unwrap(), None);
        assert!(arg::<String>(args, "missing").is_err());
    }

    #[test]
    fn query_values_are_percent_decoded() {
        assert_eq!(
            query_param("event=pty%3A%2F%2F01J%2Fdata&x=1", "event").as_deref(),
            Some("pty://01J/data")
        );
        assert_eq!(query_param("event=regis%3A%2F%2Fevent", "other"), None);
        assert_eq!(query_param("event=%zz", "event"), None);
    }

    #[test]
    fn only_local_origins_are_trusted() {
        assert!(is_local_origin(None));
        assert!(is_local_origin(Some("http://localhost:1420")));
        assert!(is_local_origin(Some("http://127.0.0.1:1420")));
        assert!(is_local_origin(Some("http://[::1]:1420")));
        assert!(!is_local_origin(Some("https://evil.example")));
        assert!(!is_local_origin(Some("http://localhost.evil.example:1420")));
        assert!(!is_local_origin(Some("null")));
    }

    #[test]
    fn sse_frames_wrap_the_payload() {
        assert_eq!(sse_frame("{\"a\":1}"), Bytes::from("data: {\"a\":1}\n\n"));
    }
}
