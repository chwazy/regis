use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use tokio::sync::mpsc::Sender;

use super::{AudioError, AudioFrame, AudioSource, FrameBuilder};

pub trait CaptureBackend: Send {
    /// Démarre la capture ; chaque AudioFrame (≈ 100 ms) est poussé dans `tx`.
    fn start(
        &mut self,
        source: AudioSource,
        device_id: Option<&str>,
        tx: Sender<AudioFrame>,
    ) -> Result<(), AudioError>;
    fn stop(&mut self);
}

/// Le stream cpal n'est pas `Send` sous Windows : il vit dans un thread dédié.
#[derive(Default)]
pub struct CpalBackend {
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl CpalBackend {
    pub fn new() -> CpalBackend {
        CpalBackend::default()
    }
}

impl CaptureBackend for CpalBackend {
    fn start(
        &mut self,
        source: AudioSource,
        device_id: Option<&str>,
        tx: Sender<AudioFrame>,
    ) -> Result<(), AudioError> {
        if !super::is_capture_supported() {
            return Err(AudioError::Unsupported(
                "capture audio disponible sous Windows uniquement".to_owned(),
            ));
        }
        self.stop();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let device_id = device_id.map(str::to_owned);
        let thread = std::thread::spawn(move || {
            native::run(source, device_id, tx, ready_tx, stop_rx);
        });
        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.stop_tx = Some(stop_tx);
                self.thread = Some(thread);
                Ok(())
            }
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                Err(AudioError::Stream(
                    "le thread de capture s'est arrêté".to_owned(),
                ))
            }
        }
    }

    fn stop(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for CpalBackend {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
mod native {
    use std::sync::mpsc::{Receiver, Sender as StdSender};

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};
    use tokio::sync::mpsc::Sender;

    use crate::audio::{AudioError, AudioFrame, AudioSource, FrameBuilder};

    pub fn run(
        source: AudioSource,
        device_id: Option<String>,
        tx: Sender<AudioFrame>,
        ready_tx: StdSender<Result<(), AudioError>>,
        stop_rx: Receiver<()>,
    ) {
        match open_stream(source, device_id.as_deref(), tx) {
            Ok(stream) => {
                let _ = ready_tx.send(Ok(()));
                let _ = stop_rx.recv();
                drop(stream);
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error));
            }
        }
    }

    fn stream_error(error: impl std::fmt::Display) -> AudioError {
        AudioError::Stream(error.to_string())
    }

    fn open_stream(
        source: AudioSource,
        device_id: Option<&str>,
        tx: Sender<AudioFrame>,
    ) -> Result<cpal::Stream, AudioError> {
        let host = cpal::default_host();
        let device = match device_id {
            Some(id) => {
                let parsed = id.parse().map_err(stream_error)?;
                host.device_by_id(&parsed)
                    .ok_or_else(|| AudioError::NoDevice(id.to_owned()))?
            }
            None => match source {
                AudioSource::Microphone => host.default_input_device(),
                AudioSource::SystemLoopback => host.default_output_device(),
            }
            .ok_or_else(|| AudioError::NoDevice("aucun périphérique par défaut".to_owned()))?,
        };
        // Un périphérique de sortie ouvert en entrée active le loopback WASAPI dans cpal.
        let supported = match source {
            AudioSource::Microphone => device.default_input_config(),
            AudioSource::SystemLoopback => device.default_output_config(),
        }
        .map_err(stream_error)?;
        let channels = supported.channels();
        let sample_rate = supported.sample_rate();
        let format = supported.sample_format();
        let config: StreamConfig = supported.into();
        let builder = FrameBuilder::new(source, channels, sample_rate);
        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, config, builder, tx),
            SampleFormat::F64 => build::<f64>(&device, config, builder, tx),
            SampleFormat::I16 => build::<i16>(&device, config, builder, tx),
            SampleFormat::I32 => build::<i32>(&device, config, builder, tx),
            SampleFormat::I8 => build::<i8>(&device, config, builder, tx),
            SampleFormat::U8 => build::<u8>(&device, config, builder, tx),
            SampleFormat::U16 => build::<u16>(&device, config, builder, tx),
            other => Err(AudioError::Unsupported(format!(
                "format d'échantillon {other}"
            ))),
        }?;
        stream.play().map_err(stream_error)?;
        Ok(stream)
    }

    fn build<T>(
        device: &cpal::Device,
        config: StreamConfig,
        mut builder: FrameBuilder,
        tx: Sender<AudioFrame>,
    ) -> Result<cpal::Stream, AudioError>
    where
        T: SizedSample + Send + 'static,
        f32: FromSample<T>,
    {
        device
            .build_input_stream(
                config,
                move |data: &[T], _| {
                    let floats: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                    for frame in builder.push(&floats) {
                        let _ = tx.try_send(frame);
                    }
                },
                |_error| {},
                None,
            )
            .map_err(stream_error)
    }
}

#[cfg(not(windows))]
mod native {
    use std::sync::mpsc::{Receiver, Sender as StdSender};

    use tokio::sync::mpsc::Sender;

    use crate::audio::{AudioError, AudioFrame, AudioSource};

    pub fn run(
        _source: AudioSource,
        _device_id: Option<String>,
        _tx: Sender<AudioFrame>,
        ready_tx: StdSender<Result<(), AudioError>>,
        _stop_rx: Receiver<()>,
    ) {
        let _ = ready_tx.send(Err(AudioError::Unsupported(
            "capture audio disponible sous Windows uniquement".to_owned(),
        )));
    }
}

/// Rejoue un WAV (démo et tests) aussi vite que le consommateur lit les trames.
pub struct WavFileBackend {
    pub path: PathBuf,
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl WavFileBackend {
    pub fn new(path: PathBuf) -> WavFileBackend {
        WavFileBackend {
            path,
            stop_flag: Arc::new(AtomicBool::new(false)),
            thread: None,
        }
    }
}

struct WavData {
    channels: u16,
    sample_rate: u32,
    samples: Vec<f32>,
}

fn read_wav(path: &Path) -> Result<WavData, AudioError> {
    let file_error = |error: hound::Error| AudioError::File(error.to_string());
    let mut reader = hound::WavReader::open(path).map_err(file_error)?;
    let spec = reader.spec();
    let samples = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<f32>, _>>()
            .map_err(file_error)?,
        hound::SampleFormat::Int => {
            let scale = 2f32.powi(i32::from(spec.bits_per_sample) - 1);
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<f32>, _>>()
                .map_err(file_error)?
        }
    };
    Ok(WavData {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        samples,
    })
}

impl CaptureBackend for WavFileBackend {
    fn start(
        &mut self,
        source: AudioSource,
        _device_id: Option<&str>,
        tx: Sender<AudioFrame>,
    ) -> Result<(), AudioError> {
        self.stop();
        let wav = read_wav(&self.path)?;
        self.stop_flag = Arc::new(AtomicBool::new(false));
        let stop_flag = self.stop_flag.clone();
        self.thread = Some(std::thread::spawn(move || {
            let mut builder = FrameBuilder::new(source, wav.channels, wav.sample_rate);
            let block = usize::from(wav.channels.max(1)) * (wav.sample_rate as usize / 10).max(1);
            let blocks = wav.samples.chunks(block).map(|chunk| builder.push(chunk));
            let mut frames = blocks.flatten().collect::<Vec<_>>();
            frames.extend(builder.finish());
            for frame in frames {
                if stop_flag.load(Ordering::Relaxed) || tx.blocking_send(frame).is_err() {
                    break;
                }
            }
        }));
        Ok(())
    }

    fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for WavFileBackend {
    fn drop(&mut self) {
        self.stop();
    }
}

pub const DEMO_FIXTURE_RELATIVE: &str = "tests/fixtures/audio/fr-phrase.wav";

pub fn demo_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../..")
        .join(DEMO_FIXTURE_RELATIVE)
}

pub fn new_backend() -> Box<dyn CaptureBackend> {
    if regis_core::demo::is_enabled() {
        Box::new(WavFileBackend::new(demo_fixture_path()))
    } else {
        Box::new(CpalBackend::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../../tests/fixtures/audio")
            .join(name)
    }

    #[tokio::test]
    async fn wav_backend_replays_a_stereo_48k_file_as_16k_frames() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let mut backend = WavFileBackend::new(fixture("stereo-48k.wav"));
        backend
            .start(AudioSource::Microphone, None, tx)
            .expect("start");
        let mut total = 0usize;
        let mut offsets = Vec::new();
        while let Some(frame) = rx.recv().await {
            total += frame.samples.len();
            offsets.push(frame.offset_ms);
        }
        assert!((15_840..=16_160).contains(&total), "{total}");
        assert!(offsets.len() > 1);
        assert!(offsets.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn wav_backend_reports_a_missing_file() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut backend = WavFileBackend::new(fixture("absent.wav"));
        let result = backend.start(AudioSource::Microphone, None, tx);
        assert!(matches!(result, Err(AudioError::File(_))));
    }

    #[cfg(not(windows))]
    #[test]
    fn cpal_backend_is_unsupported_off_windows() {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let result = CpalBackend::new().start(AudioSource::Microphone, None, tx);
        assert!(matches!(result, Err(AudioError::Unsupported(_))));
    }
}
