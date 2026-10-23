use regis_core::db::repo::{self, RepoError};
use regis_core::db::Db;

use super::{AudioDevice, AudioError, AudioSource};

pub const SETTING_MIC_DEVICE: &str = "audio.micDeviceId";
pub const SETTING_LOOPBACK_DEVICE: &str = "audio.loopbackDeviceId";

pub fn setting_key(source: AudioSource) -> &'static str {
    match source {
        AudioSource::Microphone => SETTING_MIC_DEVICE,
        AudioSource::SystemLoopback => SETTING_LOOPBACK_DEVICE,
    }
}

/// Valeur absente ou vide = périphérique par défaut.
pub fn normalize_device_setting(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

pub fn device_id_from_settings(db: &Db, source: AudioSource) -> Result<Option<String>, RepoError> {
    db.with_conn(|conn| repo::get_setting(conn, setting_key(source)))
        .map(normalize_device_setting)
}

#[cfg(windows)]
pub fn list_devices() -> Result<Vec<AudioDevice>, AudioError> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let default_id = |device: Option<cpal::Device>| {
        device
            .and_then(|device| device.id().ok())
            .map(|id| id.to_string())
    };
    let default_input = default_id(host.default_input_device());
    let default_output = default_id(host.default_output_device());
    let describe = |device: &cpal::Device, source: AudioSource, default: &Option<String>| {
        let id = device.id().ok()?.to_string();
        let name = device
            .description()
            .map(|description| description.name().to_owned())
            .unwrap_or_else(|_| id.clone());
        Some(AudioDevice {
            is_default: default.as_deref() == Some(id.as_str()),
            id,
            name,
            source,
        })
    };
    let mut devices = Vec::new();
    let inputs = host
        .input_devices()
        .map_err(|error| AudioError::Stream(error.to_string()))?;
    devices.extend(inputs.filter_map(|d| describe(&d, AudioSource::Microphone, &default_input)));
    let outputs = host
        .output_devices()
        .map_err(|error| AudioError::Stream(error.to_string()))?;
    devices
        .extend(outputs.filter_map(|d| describe(&d, AudioSource::SystemLoopback, &default_output)));
    Ok(devices)
}

#[cfg(not(windows))]
pub fn list_devices() -> Result<Vec<AudioDevice>, AudioError> {
    Err(AudioError::Unsupported(
        "énumération des périphériques réservée à Windows".to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_or_missing_setting_means_default_device() {
        assert_eq!(normalize_device_setting(None), None);
        assert_eq!(normalize_device_setting(Some("  ".into())), None);
        assert_eq!(
            normalize_device_setting(Some("wasapi:abc".into())),
            Some("wasapi:abc".into())
        );
    }

    #[test]
    fn setting_keys_match_the_spec() {
        assert_eq!(setting_key(AudioSource::Microphone), "audio.micDeviceId");
        assert_eq!(
            setting_key(AudioSource::SystemLoopback),
            "audio.loopbackDeviceId"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "nécessite une entrée et une sortie audio"]
    fn lists_a_microphone_and_a_loopback_on_windows() {
        let devices = list_devices().unwrap();
        assert!(devices.iter().any(|d| d.source == AudioSource::Microphone));
        assert!(devices
            .iter()
            .any(|d| d.source == AudioSource::SystemLoopback));
    }
}
