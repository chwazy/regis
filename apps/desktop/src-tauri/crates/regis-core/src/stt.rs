use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SttSegment {
    #[ts(type = "number")]
    pub start_ms: u64,
    #[ts(type = "number")]
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct TranscribeOptions {
    pub language: String,
    pub initial_prompt: Option<String>,
}

pub trait SttEngine: Send + Sync {
    /// `samples` : 16 kHz mono f32. Les horodatages des segments sont relatifs au début de `samples`.
    fn transcribe(
        &self,
        samples: &[f32],
        opts: &TranscribeOptions,
    ) -> Result<Vec<SttSegment>, SttError>;
}

#[derive(Debug, thiserror::Error)]
pub enum SttError {
    #[error("modèle de transcription absent : {0}")]
    ModelMissing(String),
    #[error("modèle corrompu (SHA-256) : {0}")]
    ModelCorrupt(String),
    #[error("chargement du modèle : {0}")]
    Load(String),
    #[error("transcription : {0}")]
    Inference(String),
    #[error("téléchargement : {0}")]
    Download(String),
}

/// L'inférence bloque un cœur : toujours hors du runtime async.
pub async fn transcribe_blocking(
    engine: std::sync::Arc<dyn SttEngine>,
    samples: Vec<f32>,
    opts: TranscribeOptions,
) -> Result<Vec<SttSegment>, SttError> {
    tokio::task::spawn_blocking(move || engine.transcribe(&samples, &opts))
        .await
        .map_err(|error| SttError::Inference(error.to_string()))?
}
