pub mod models;
pub mod state;

pub use regis_core::stt::{
    transcribe_blocking, SttEngine, SttError, SttSegment, TranscribeOptions,
};
pub use state::SttState;

/// Réglage SQLite du modèle de transcription choisi.
pub const SETTING_STT_MODEL: &str = "stt.model";

/// Renvoie ses segments tels quels (tests et mode démo).
pub struct FakeSttEngine {
    pub segments: Vec<SttSegment>,
}

pub const DEMO_TRANSCRIPT: &str = "Ceci est une dictée de démonstration.";

impl FakeSttEngine {
    pub fn demo() -> FakeSttEngine {
        FakeSttEngine {
            segments: vec![SttSegment {
                start_ms: 0,
                end_ms: 2_000,
                text: DEMO_TRANSCRIPT.to_owned(),
            }],
        }
    }
}

impl SttEngine for FakeSttEngine {
    fn transcribe(
        &self,
        _samples: &[f32],
        _opts: &TranscribeOptions,
    ) -> Result<Vec<SttSegment>, SttError> {
        Ok(self.segments.clone())
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use regis_stt_whisper::WhisperEngine;

    use super::*;
    use crate::audio::capture::{CaptureBackend, WavFileBackend};
    use crate::audio::AudioSource;

    #[test]
    fn fake_engine_returns_its_segments_unchanged() {
        let engine = FakeSttEngine::demo();
        let options = TranscribeOptions {
            language: "fr".into(),
            initial_prompt: None,
        };
        let segments = engine.transcribe(&[0.0; 16], &options).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, DEMO_TRANSCRIPT);
    }

    fn fold(text: &str) -> String {
        text.to_lowercase()
            .chars()
            .map(|c| match c {
                'é' | 'è' | 'ê' | 'ë' => 'e',
                'à' | 'â' => 'a',
                'î' | 'ï' => 'i',
                'ô' => 'o',
                'ù' | 'û' => 'u',
                'ç' => 'c',
                other => other,
            })
            .collect()
    }

    #[test]
    #[ignore = "nécessite REGIS_STT_TEST_MODEL (modèle ggml)"]
    fn whisper_transcribes_french_fixture() {
        let model = std::env::var("REGIS_STT_TEST_MODEL").expect("REGIS_STT_TEST_MODEL");
        let engine = WhisperEngine::load(Path::new(&model)).unwrap();
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../../tests/fixtures/audio/fr-phrase.wav");
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        let mut backend = WavFileBackend::new(fixture);
        backend.start(AudioSource::Microphone, None, tx).unwrap();
        let mut samples = Vec::new();
        while let Some(frame) = rx.blocking_recv() {
            samples.extend(frame.samples);
        }
        let options = TranscribeOptions {
            language: "fr".into(),
            initial_prompt: None,
        };
        let segments = engine.transcribe(&samples, &options).unwrap();
        let text = fold(
            &segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        );
        assert!(text.contains("bonjour"), "{text}");
        assert!(text.contains("transcription"), "{text}");
    }
}
