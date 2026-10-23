use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FileSource {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub watch_mode: String,
    #[ts(type = "number | null")]
    pub poll_minutes: Option<i64>,
    pub state: String,
    pub last_scan_at: Option<String>,
    pub connector_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub source_id: String,
    pub rel_path: String,
    pub ext: String,
    #[ts(type = "number")]
    pub size: i64,
    pub mtime: String,
    pub sha256: Option<String>,
    pub role: String,
    pub status: String,
    pub indexed_at: Option<String>,
}
