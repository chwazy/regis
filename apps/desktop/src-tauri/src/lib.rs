pub mod audio;
mod commands;
#[cfg(debug_assertions)]
mod dev_bridge;
mod paths;
mod pty;
mod tauri_events;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tauri::Manager;

use regis_core::db::Db;
use regis_core::db::DATABASE_FILE;
use regis_core::events::EventBus;
use regis_core::sidecar::{HostError, LaunchSpec, SidecarClient};
use regis_core::store_rpc::StoreContext;
use tauri_events::{TauriObserver, TauriSink};

pub struct AppState {
    pub db: Arc<Db>,
    pub bus: EventBus,
    pub data_dir: PathBuf,
    pub data_dir_origin: paths::DataDirOrigin,
    pub config_dir: PathBuf,
    pub sidecar: SidecarClient,
    pub files: regis_core::files::watcher::WatcherHandle,
    pub pty: Arc<pty::PtyManager>,
    pub stt: Arc<regis_voice::stt::SttState>,
    pub modules: Arc<regis_voice::modules::ModuleManager>,
    pub dictation: regis_voice::audio::dictation::DictationManager,
    pub recording: regis_voice::audio::recording::RecordingManager,
}

const ODOO_MCP_BIN_ENV: &str = "REGIS_ODOO_MCP_BIN";
const ODOO_MCP_ENTRY_ENV: &str = "REGIS_ODOO_MCP_ENTRY";

fn sidecar_launch_spec() -> LaunchSpec {
    if cfg!(debug_assertions) {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        return LaunchSpec {
            program: "node".into(),
            args: vec![repo_root.join("sidecar/dist/index.js").into_os_string()],
            env: vec![(
                ODOO_MCP_ENTRY_ENV.into(),
                repo_root.join("sidecar/dist/odoo-mcp.js").into_os_string(),
            )],
            current_dir: Some(repo_root),
        };
    }
    let bundled = |basename: &str| {
        let executable_name = if cfg!(windows) {
            format!("{basename}.exe")
        } else {
            basename.to_owned()
        };
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(&executable_name)))
            .unwrap_or_else(|| PathBuf::from(executable_name))
    };
    LaunchSpec {
        program: bundled("regis-sidecar").into_os_string(),
        args: Vec::new(),
        env: vec![(
            ODOO_MCP_BIN_ENV.into(),
            bundled("regis-odoo-mcp").into_os_string(),
        )],
        current_dir: None,
    }
}

fn register_host_methods(sidecar: &SidecarClient) {
    sidecar.register_host_method(
        "host.ping",
        Arc::new(|_params| Box::pin(async { Ok(json!({ "ok": true })) })),
    );
}

#[derive(serde::Deserialize)]
struct PtyOpenParams {
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    env: std::collections::HashMap<String, String>,
}

fn register_pty_host_methods(sidecar: &SidecarClient, pty: Arc<pty::PtyManager>) {
    let opener = pty.clone();
    sidecar.register_host_method(
        "pty.open",
        Arc::new(move |params| {
            let opener = opener.clone();
            Box::pin(async move {
                let params: PtyOpenParams = serde_json::from_value(params)
                    .map_err(|error| HostError::InvalidParams(error.to_string()))?;
                let env: Vec<(String, String)> = params.env.into_iter().collect();
                opener
                    .open(
                        &params.id,
                        &params.program,
                        &params.args,
                        &PathBuf::from(params.cwd),
                        params.cols,
                        params.rows,
                        &env,
                    )
                    .map_err(|error| HostError::Internal(error.to_string()))?;
                Ok(json!({ "opened": true }))
            })
        }),
    );
    sidecar.register_host_method(
        "pty.close",
        Arc::new(move |params| {
            let id = params
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_owned();
            let closed = pty.close(&id).is_ok();
            Box::pin(async move { Ok(json!({ "closed": closed })) })
        }),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if regis_core::uninstall::is_uninstall_invocation(&args) {
        regis_core::uninstall::run_cli(&context.config().identifier);
        return;
    }
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::sidecar_call,
            commands::data::list_jobs,
            commands::data::get_job,
            commands::data::list_job_events,
            commands::data::list_approvals,
            commands::data::resolve_approval,
            commands::data::list_agents,
            commands::data::save_agent,
            commands::data::delete_agent,
            commands::data::list_connectors,
            commands::data::save_connector,
            commands::data::delete_connector,
            commands::data::list_policies,
            commands::data::save_policy,
            commands::data::list_rules,
            commands::data::save_rules,
            commands::data::set_secret,
            commands::data::delete_secret,
            commands::data::get_setting,
            commands::data::set_setting,
            commands::settings::get_app_info,
            commands::settings::set_data_dir,
            commands::files::list_file_sources,
            commands::files::add_file_source,
            commands::files::remove_file_source,
            commands::files::rescan_source,
            commands::files::import_files,
            commands::files::import_clipboard_image,
            commands::files::list_files,
            commands::files::link_file,
            commands::files::list_linkable_entities,
            commands::files::search,
            commands::templates::list_templates,
            commands::templates::update_template,
            commands::templates::import_template,
            commands::templates::open_template,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_close,
            commands::brain::list_entities,
            commands::brain::get_entity_card,
            commands::brain::set_fact_status,
            commands::brain::add_entity_note,
            commands::brain::update_entity,
            commands::brain::global_search,
            commands::dashboard::list_dashboards,
            commands::dashboard::save_dashboard,
            commands::dashboard::delete_dashboard,
            commands::dashboard::list_widgets,
            commands::dashboard::save_widgets,
            commands::dashboard::delete_widget,
            commands::dashboard::widget_data,
            commands::audio::audio_list_devices,
            commands::audio::audio_test_level,
            commands::audio::stt_status,
            commands::audio::stt_download_model,
            commands::audio::dictation_start,
            commands::audio::dictation_stop,
            commands::audio::dictation_cancel,
            commands::modules::modules_status,
            commands::modules::module_enable,
            commands::modules::module_disable,
            commands::modules::module_delete_model,
            commands::meetings::open_meeting,
            commands::recording::recording_start,
            commands::recording::recording_stop,
            commands::recording::recording_active,
            commands::recording::recording_get,
            commands::recording::recording_delete_audio,
            commands::recording::minutes_get,
            commands::recording::minutes_generate,
            commands::recording::minutes_export
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let (data_dir, data_dir_origin) = paths::data_dir_with_origin(&handle);
            let config_dir = paths::config_dir(&handle);
            std::fs::create_dir_all(&data_dir)?;
            let db = Arc::new(Db::open(&data_dir.join(DATABASE_FILE))?);
            if let Err(error) = regis_core::bootstrap::ensure_marker(&data_dir) {
                eprintln!("[bootstrap] marqueur regis-data.json impossible : {error}");
            }
            regis_voice::seed::seed_defaults(&db, &data_dir)?;
            let demo_mode = regis_core::demo::is_enabled();
            if demo_mode {
                regis_core::demo::seed(&db)?;
            }
            regis_core::files::sources::ensure_regis_sources(&db, &data_dir)?;
            let bus = EventBus::new(Arc::new(TauriSink(handle.clone())));
            let sidecar = SidecarClient::new();
            register_host_methods(&sidecar);
            let jobs_data_dir = data_dir.clone();
            sidecar.register_host_method(
                "host.dataDir",
                Arc::new(move |_params| {
                    let path = jobs_data_dir.to_string_lossy().into_owned();
                    Box::pin(async move { Ok(json!({ "path": path })) })
                }),
            );
            regis_core::store_rpc::register_host_methods(
                &sidecar,
                StoreContext {
                    db: db.clone(),
                    bus: bus.clone(),
                    data_dir: data_dir.clone(),
                },
            );
            commands::brain::register_host_methods(&sidecar, db.clone());
            regis_core::secrets::register_host_methods(&sidecar);
            let pty = Arc::new(pty::PtyManager::new(Arc::new(pty::TauriPtySink {
                app: handle.clone(),
                sidecar: sidecar.clone(),
            })));
            register_pty_host_methods(&sidecar, pty.clone());
            let files = tauri::async_runtime::block_on(async {
                regis_core::files::watcher::spawn(db.clone(), bus.clone())
            });
            if !demo_mode {
                tauri::async_runtime::spawn(regis_voice::scheduler::run(
                    db.clone(),
                    sidecar.clone(),
                    data_dir.clone(),
                ));
            }
            match regis_voice::audio::recording::RecordingManager::recover_interrupted(&db) {
                Ok(0) => {}
                Ok(count) => {
                    eprintln!("[recording] {count} session(s) interrompue(s) récupérée(s)")
                }
                Err(error) => {
                    eprintln!("[recording] reprise après interruption impossible : {error}")
                }
            }
            let stt = Arc::new(regis_voice::stt::SttState::new());
            let modules = Arc::new(regis_voice::modules::ModuleManager::new(stt.clone()));
            let recording = commands::recording::build_recording_manager(
                db.clone(),
                stt.clone(),
                data_dir.clone(),
                bus.clone(),
                Some(Arc::new(audio::indicator::TauriIndicator::new(
                    handle.clone(),
                ))),
            );
            let dictation = commands::audio::build_dictation_manager(
                db.clone(),
                stt.clone(),
                data_dir.clone(),
                bus.clone(),
                recording.clone(),
            );
            app.manage(AppState {
                db,
                bus,
                data_dir,
                data_dir_origin,
                config_dir,
                sidecar: sidecar.clone(),
                files,
                pty,
                stt,
                modules,
                dictation,
                recording,
            });
            #[cfg(debug_assertions)]
            dev_bridge::spawn(handle.clone());
            tauri::async_runtime::spawn(sidecar.supervise(
                sidecar_launch_spec(),
                Arc::new(TauriObserver { app: handle }),
            ));
            Ok(())
        })
        .run(context)
        .expect("error while running the Régis desktop application");
}
