use std::path::Path;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use regis_core::stt::{SttEngine, SttError, SttSegment, TranscribeOptions};

pub struct WhisperEngine {
    context: WhisperContext,
}

impl WhisperEngine {
    pub fn load(model_path: &Path) -> Result<Self, SttError> {
        if !model_path.is_file() {
            return Err(SttError::ModelMissing(model_path.display().to_string()));
        }
        // Sans backend de log, ceci coupe les traces natives de whisper.cpp (qui contiennent le texte).
        whisper_rs::install_logging_hooks();
        let path = model_path
            .to_str()
            .ok_or_else(|| SttError::Load("chemin du modèle non UTF-8".to_owned()))?;
        let context = WhisperContext::new_with_params(path, WhisperContextParameters::default())
            .map_err(|error| SttError::Load(error.to_string()))?;
        Ok(WhisperEngine { context })
    }
}

impl SttEngine for WhisperEngine {
    fn transcribe(
        &self,
        samples: &[f32],
        opts: &TranscribeOptions,
    ) -> Result<Vec<SttSegment>, SttError> {
        let inference = |error: whisper_rs::WhisperError| SttError::Inference(error.to_string());
        let mut state = self.context.create_state().map_err(inference)?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(opts.language.as_str()));
        if let Some(prompt) = opts.initial_prompt.as_deref() {
            params.set_initial_prompt(prompt);
        }
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state.full(params, samples).map_err(inference)?;
        let mut segments = Vec::new();
        for segment in state.as_iter() {
            let text = segment.to_str_lossy().map_err(inference)?;
            // Les horodatages whisper sont en centièmes de seconde.
            segments.push(SttSegment {
                start_ms: segment.start_timestamp().max(0) as u64 * 10,
                end_ms: segment.end_timestamp().max(0) as u64 * 10,
                text: text.trim().to_owned(),
            });
        }
        Ok(segments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loading_a_missing_model_is_a_typed_error() {
        let result = WhisperEngine::load(Path::new("absent/ggml-nothing.bin"));
        assert!(matches!(result, Err(SttError::ModelMissing(_))));
    }
}
