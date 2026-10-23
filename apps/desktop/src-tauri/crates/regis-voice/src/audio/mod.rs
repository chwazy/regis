pub mod capture;
pub mod chunker;
pub mod devices;
pub mod diarize;
pub mod dictation;
pub mod recording;
pub mod transcript;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum AudioSource {
    Microphone,
    SystemLoopback,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub source: AudioSource,
    pub is_default: bool,
}

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Bloc audio déjà converti : 16 kHz, mono, f32 dans [-1, 1].
pub struct AudioFrame {
    pub source: AudioSource,
    pub samples: Vec<f32>,
    pub offset_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("aucun périphérique audio : {0}")]
    NoDevice(String),
    #[error("capture non prise en charge sur cette plateforme : {0}")]
    Unsupported(String),
    #[error("flux audio : {0}")]
    Stream(String),
    #[error("fichier audio : {0}")]
    File(String),
}

/// Moyenne des canaux de chaque trame ; une trame incomplète finale est ignorée.
pub fn downmix_to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    match channels {
        0 => Vec::new(),
        1 => interleaved.to_vec(),
        count => interleaved
            .chunks_exact(usize::from(count))
            .map(|frame| frame.iter().sum::<f32>() / f32::from(count))
            .collect(),
    }
}

/// Rééchantillonne un tampon complet vers 16 kHz (filtre sinc fenêtré anti-repliement).
pub fn resample_to_16k(mono: &[f32], from_hz: u32) -> Vec<f32> {
    if from_hz == TARGET_SAMPLE_RATE || from_hz == 0 {
        return mono.to_vec();
    }
    let mut resampler = StreamResampler::new(from_hz);
    let mut output = resampler.process(mono);
    output.extend(resampler.finish());
    output
}

pub fn rms_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy: f64 = samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
    ((energy / samples.len() as f64).sqrt() as f32).clamp(0.0, 1.0)
}

pub fn is_capture_supported() -> bool {
    cfg!(windows)
}

pub fn is_loopback_supported() -> bool {
    cfg!(windows)
}

const SINC_ZERO_CROSSINGS: f64 = 16.0;
const CUTOFF_MARGIN: f64 = 0.95;

/// Rééchantillonneur vers 16 kHz avec mémoire entre les blocs (pas d'artefact aux jointures).
pub struct StreamResampler {
    passthrough: bool,
    ratio: f64,
    cutoff: f64,
    half_width: usize,
    buffer: Vec<f32>,
    next_position: f64,
    input_total: u64,
    output_total: u64,
}

impl StreamResampler {
    pub fn new(from_hz: u32) -> StreamResampler {
        let ratio = f64::from(from_hz) / f64::from(TARGET_SAMPLE_RATE);
        let cutoff = 0.5 * CUTOFF_MARGIN / ratio.max(1.0);
        let half_width = (SINC_ZERO_CROSSINGS / (2.0 * cutoff)).ceil() as usize;
        StreamResampler {
            passthrough: from_hz == TARGET_SAMPLE_RATE || from_hz == 0,
            ratio,
            cutoff,
            half_width,
            buffer: vec![0.0; half_width],
            next_position: half_width as f64,
            input_total: 0,
            output_total: 0,
        }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.passthrough {
            return input.to_vec();
        }
        self.input_total += input.len() as u64;
        self.buffer.extend_from_slice(input);
        let mut output = Vec::new();
        while self.next_position + self.half_width as f64 + 1.0 <= self.buffer.len() as f64 {
            output.push(self.interpolate(self.next_position));
            self.next_position += self.ratio;
        }
        let keep_from = (self.next_position.floor() as usize).saturating_sub(self.half_width);
        if keep_from > 0 {
            self.buffer.drain(..keep_from);
            self.next_position -= keep_from as f64;
        }
        self.output_total += output.len() as u64;
        output
    }

    /// Vide la queue du filtre ; le total produit vaut ceil(entrées / ratio).
    pub fn finish(&mut self) -> Vec<f32> {
        if self.passthrough {
            return Vec::new();
        }
        let expected = (self.input_total as f64 / self.ratio).ceil() as u64;
        let produced_before = self.output_total;
        let padding = vec![0.0; self.half_width + 2 + self.ratio.ceil() as usize];
        let mut tail = self.process(&padding);
        let wanted = expected.saturating_sub(produced_before) as usize;
        tail.truncate(wanted);
        self.output_total = produced_before + tail.len() as u64;
        tail
    }

    fn interpolate(&self, position: f64) -> f32 {
        let center = position.floor() as isize;
        let half = self.half_width as isize;
        let (mut sum, mut weights) = (0.0f64, 0.0f64);
        for index in (center - half + 1)..=(center + half) {
            let distance = index as f64 - position;
            let window_phase = distance / self.half_width as f64;
            if window_phase.abs() >= 1.0 {
                continue;
            }
            let argument = 2.0 * self.cutoff * distance;
            let sinc = if argument.abs() < 1e-12 {
                1.0
            } else {
                (std::f64::consts::PI * argument).sin() / (std::f64::consts::PI * argument)
            };
            let window = 0.42
                + 0.5 * (std::f64::consts::PI * window_phase).cos()
                + 0.08 * (2.0 * std::f64::consts::PI * window_phase).cos();
            let weight = sinc * window;
            weights += weight;
            sum += weight * f64::from(self.buffer[index as usize]);
        }
        (sum / weights) as f32
    }
}

const FRAME_SAMPLES: usize = (TARGET_SAMPLE_RATE / 10) as usize;

/// Convertit des blocs au format natif du périphérique en trames 16 kHz mono de ≈ 100 ms.
pub struct FrameBuilder {
    source: AudioSource,
    channels: u16,
    resampler: StreamResampler,
    pending: Vec<f32>,
    emitted_samples: u64,
}

impl FrameBuilder {
    pub fn new(source: AudioSource, channels: u16, from_hz: u32) -> FrameBuilder {
        FrameBuilder {
            source,
            channels,
            resampler: StreamResampler::new(from_hz),
            pending: Vec::new(),
            emitted_samples: 0,
        }
    }

    pub fn push(&mut self, interleaved: &[f32]) -> Vec<AudioFrame> {
        let mono = downmix_to_mono(interleaved, self.channels);
        self.pending.extend(self.resampler.process(&mono));
        self.drain_frames(false)
    }

    pub fn finish(&mut self) -> Vec<AudioFrame> {
        let tail = self.resampler.finish();
        self.pending.extend(tail);
        self.drain_frames(true)
    }

    fn drain_frames(&mut self, flush: bool) -> Vec<AudioFrame> {
        let mut frames = Vec::new();
        while self.pending.len() >= FRAME_SAMPLES || (flush && !self.pending.is_empty()) {
            let take = FRAME_SAMPLES.min(self.pending.len());
            let samples: Vec<f32> = self.pending.drain(..take).collect();
            let offset_ms = self.emitted_samples * 1000 / u64::from(TARGET_SAMPLE_RATE);
            self.emitted_samples += samples.len() as u64;
            frames.push(AudioFrame {
                source: self.source,
                samples,
                offset_ms,
            });
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, rate: u32, count: usize) -> Vec<f32> {
        (0..count)
            .map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn downmix_averages_stereo_pairs() {
        let mono = downmix_to_mono(&[0.2, 0.4, -0.2, -0.4], 2);
        assert_eq!(mono.len(), 2);
        assert!((mono[0] - 0.3).abs() < 1e-6);
        assert!((mono[1] + 0.3).abs() < 1e-6);
    }

    #[test]
    fn rms_of_empty_is_zero_and_of_unit_sine_is_about_0_707() {
        assert_eq!(rms_level(&[]), 0.0);
        let level = rms_level(&sine(440.0, 16_000, 16_000));
        assert!((0.70..=0.72).contains(&level), "{level}");
    }

    #[test]
    fn resample_48k_gives_16k_samples() {
        let output = resample_to_16k(&sine(440.0, 48_000, 48_000), 48_000);
        assert!(
            (15_999..=16_001).contains(&output.len()),
            "{}",
            output.len()
        );
    }

    #[test]
    fn resample_keeps_a_16k_buffer_unchanged() {
        let input = sine(440.0, 16_000, 500);
        assert_eq!(resample_to_16k(&input, 16_000), input);
    }

    #[test]
    fn resample_preserves_a_tone_and_removes_aliasing() {
        let tone = resample_to_16k(&sine(440.0, 48_000, 48_000), 48_000);
        assert!((rms_level(&tone[2_000..14_000]) - 0.707).abs() < 0.02);
        // 12 kHz serait replié à 4 kHz par une décimation naïve.
        let alias = resample_to_16k(&sine(12_000.0, 48_000, 48_000), 48_000);
        assert!(rms_level(&alias[2_000..14_000]) < 0.02);
    }

    #[test]
    fn streaming_in_blocks_matches_the_total_length() {
        let input = sine(300.0, 44_100, 44_100);
        let mut builder = FrameBuilder::new(AudioSource::Microphone, 1, 44_100);
        let mut frames = Vec::new();
        for block in input.chunks(441) {
            frames.extend(builder.push(block));
        }
        frames.extend(builder.finish());
        let total: usize = frames.iter().map(|frame| frame.samples.len()).sum();
        assert!((15_999..=16_001).contains(&total), "{total}");
        assert!(frames
            .windows(2)
            .all(|pair| pair[0].offset_ms < pair[1].offset_ms));
    }

    #[test]
    fn platform_support_follows_the_target_os() {
        assert_eq!(is_capture_supported(), cfg!(windows));
        assert_eq!(is_loopback_supported(), cfg!(windows));
    }
}
