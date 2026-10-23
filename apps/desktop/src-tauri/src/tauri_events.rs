use serde_json::Value;
use tauri::{AppHandle, Emitter};

use regis_core::events::{iso_utc, EventSink, RegisEvent, REGIS_EVENT_CHANNEL};
use regis_core::sidecar::SidecarObserver;
use std::time::SystemTime;

/// Relaie le bus d'événements vers le webview.
pub struct TauriSink(pub AppHandle);

impl EventSink for TauriSink {
    fn publish(&self, event: RegisEvent) {
        let _ = self.0.emit(REGIS_EVENT_CHANNEL, event);
    }
}

pub struct TauriObserver {
    pub app: AppHandle,
}

impl SidecarObserver for TauriObserver {
    fn on_event(&self, event: Value) {
        let _ = self.app.emit(REGIS_EVENT_CHANNEL, event);
    }

    fn on_status(&self, state: &str) {
        let event = RegisEvent {
            topic: "sidecar.status".to_owned(),
            payload: serde_json::json!({ "state": state }),
            at: iso_utc(SystemTime::now()),
        };
        let _ = self.app.emit(REGIS_EVENT_CHANNEL, event);
    }
}
