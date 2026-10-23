use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub ord: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Widget {
    pub id: String,
    pub dashboard_id: String,
    pub kind: String,
    pub title: String,
    #[ts(type = "unknown")]
    pub config_json: serde_json::Value,
    #[ts(type = "number")]
    pub x: i64,
    #[ts(type = "number")]
    pub y: i64,
    #[ts(type = "number")]
    pub w: i64,
    #[ts(type = "number")]
    pub h: i64,
}
