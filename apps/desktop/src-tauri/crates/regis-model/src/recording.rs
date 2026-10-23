use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum RecordingStatus {
    Recording,
    Finalizing,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum RecordingSources {
    Mic,
    System,
    Both,
}

impl RecordingSources {
    pub fn includes_mic(self) -> bool {
        matches!(self, RecordingSources::Mic | RecordingSources::Both)
    }

    pub fn includes_system(self) -> bool {
        matches!(self, RecordingSources::System | RecordingSources::Both)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum SegmentSource {
    Mic,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: String,
    pub title: String,
    pub status: RecordingStatus,
    pub sources: RecordingSources,
    pub started_at: String,
    pub ended_at: Option<String>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<u64>,
    pub consent_at: String,
    pub stt_model: String,
    pub audio_available: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub source: SegmentSource,
    #[ts(type = "number")]
    pub start_ms: u64,
    #[ts(type = "number")]
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RecordingView {
    pub recording: Recording,
    pub segments: Vec<TranscriptSegment>,
    pub transcript_item_id: String,
    pub event_item_id: Option<String>,
    pub pending_chunks: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingInput {
    pub title: Option<String>,
    pub sources: RecordingSources,
    pub event_item_id: Option<String>,
    pub entity_id: Option<String>,
    pub consent_confirmed: bool,
    pub consent_text: String,
}
