use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::events::now_iso_utc;

pub const BOOTSTRAP_FILE: &str = "bootstrap.json";
pub const DATA_DIR_MARKER: &str = "regis-data.json";
const CURRENT_VERSION: u32 = 1;
const NETWORK_DIR_MESSAGE: &str = "Dossier réseau non supporté pour la base";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub version: u32,
    pub data_dir: Option<PathBuf>,
    /// URL de reprise de l'assistant (profil + étape), lue puis effacée au démarrage suivant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_url: Option<String>,
}

impl Bootstrap {
    pub fn with_data_dir(data_dir: PathBuf) -> Bootstrap {
        Bootstrap {
            version: CURRENT_VERSION,
            data_dir: Some(data_dir),
            resume_url: None,
        }
    }
}

pub fn take_resume_url(config_dir: &Path) -> Result<Option<String>, BootstrapError> {
    let Some(mut bootstrap) = read_bootstrap(config_dir)? else {
        return Ok(None);
    };
    let Some(url) = bootstrap.resume_url.take() else {
        return Ok(None);
    };
    write_bootstrap(config_dir, &bootstrap)?;
    Ok(Some(url))
}

/// L'URL de reprise ne peut viser que l'assistant, avec les seuls paramètres `profile` et `step`.
pub fn is_valid_resume_url(url: &str) -> bool {
    let Some(query) = url.strip_prefix("/bienvenue") else {
        return false;
    };
    if query.is_empty() {
        return true;
    }
    let Some(query) = query.strip_prefix('?') else {
        return false;
    };
    query.split('&').all(|pair| {
        pair.split_once('=').is_some_and(|(key, value)| {
            (key == "profile" || key == "step")
                && !value.is_empty()
                && value.chars().all(|c| c.is_ascii_lowercase())
        })
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataDirMarker {
    pub version: u32,
    pub created_at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error("le chemin doit être absolu : {0}")]
    NotAbsolute(String),
    #[error("le dossier n'est pas vide et ne contient pas de données de Régis : {0}")]
    NotEmptyNorRegis(String),
    #[error("le dossier n'est pas accessible en écriture : {0}")]
    NotWritable(String),
    #[error("le dossier de données est imposé par REGIS_DATA_DIR")]
    DataDirLockedByEnv,
    #[error("bootstrap.json illisible : {0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub fn read_bootstrap(config_dir: &Path) -> Result<Option<Bootstrap>, BootstrapError> {
    let path = config_dir.join(BOOTSTRAP_FILE);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(BootstrapError::Io(error)),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| BootstrapError::Invalid(error.to_string()))
}

fn write_atomic(path: &Path, content: &str) -> Result<(), BootstrapError> {
    let mut temp_name = path.as_os_str().to_owned();
    temp_name.push(".tmp");
    let temp = PathBuf::from(temp_name);
    fs::write(&temp, content)?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(BootstrapError::Io(error));
    }
    Ok(())
}

pub fn write_bootstrap(config_dir: &Path, bootstrap: &Bootstrap) -> Result<(), BootstrapError> {
    fs::create_dir_all(config_dir)?;
    let content = serde_json::to_string_pretty(bootstrap)
        .map_err(|error| BootstrapError::Invalid(error.to_string()))?;
    write_atomic(&config_dir.join(BOOTSTRAP_FILE), &content)
}

fn is_unc(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text.starts_with("\\\\") || text.starts_with("//")
}

pub fn has_marker(data_dir: &Path) -> bool {
    data_dir.join(DATA_DIR_MARKER).is_file()
}

fn probe_writable(dir: &Path) -> Result<(), BootstrapError> {
    let probe = dir.join(format!(".regis-write-test-{}", std::process::id()));
    fs::write(&probe, b"")
        .map_err(|error| BootstrapError::NotWritable(format!("{} ({error})", dir.display())))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

pub fn validate_data_dir(path: &Path) -> Result<(), BootstrapError> {
    if is_unc(path) {
        return Err(BootstrapError::NotWritable(NETWORK_DIR_MESSAGE.to_owned()));
    }
    if !path.is_absolute() {
        return Err(BootstrapError::NotAbsolute(path.display().to_string()));
    }
    if !path.exists() {
        let parent_ok = path
            .parent()
            .and_then(|parent| fs::metadata(parent).ok())
            .is_some_and(|meta| meta.is_dir() && !meta.permissions().readonly());
        return if parent_ok {
            Ok(())
        } else {
            Err(BootstrapError::NotWritable(path.display().to_string()))
        };
    }
    if !path.is_dir() {
        return Err(BootstrapError::NotEmptyNorRegis(path.display().to_string()));
    }
    let empty = fs::read_dir(path)?.next().is_none();
    if !empty && !has_marker(path) {
        return Err(BootstrapError::NotEmptyNorRegis(path.display().to_string()));
    }
    probe_writable(path)
}

pub fn ensure_marker(data_dir: &Path) -> Result<DataDirMarker, BootstrapError> {
    let path = data_dir.join(DATA_DIR_MARKER);
    match fs::read_to_string(&path) {
        Ok(raw) => {
            return serde_json::from_str(&raw)
                .map_err(|error| BootstrapError::Invalid(error.to_string()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(BootstrapError::Io(error)),
    }
    let marker = DataDirMarker {
        version: CURRENT_VERSION,
        created_at: now_iso_utc(),
    };
    let content = serde_json::to_string_pretty(&marker)
        .map_err(|error| BootstrapError::Invalid(error.to_string()))?;
    write_atomic(&path, &content)?;
    Ok(marker)
}

pub const DATA_DIR_ENV: &str = "REGIS_DATA_DIR";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum DataDirOrigin {
    Env,
    Bootstrap,
    Default,
}

pub fn resolve_data_dir(
    env_value: Option<OsString>,
    bootstrap: Option<&Bootstrap>,
    default_dir: PathBuf,
) -> (PathBuf, DataDirOrigin) {
    if let Some(overridden) = env_value.filter(|value| !value.is_empty()) {
        return (PathBuf::from(overridden), DataDirOrigin::Env);
    }
    if let Some(chosen) = bootstrap.and_then(|bootstrap| bootstrap.data_dir.clone()) {
        return (chosen, DataDirOrigin::Bootstrap);
    }
    (default_dir, DataDirOrigin::Default)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "regis-bootstrap-{}-{name}-{}",
            std::process::id(),
            ulid::Ulid::generate()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_without_file_is_none() {
        let dir = temp("none");
        assert_eq!(read_bootstrap(&dir).unwrap(), None);
    }

    #[test]
    fn read_invalid_json_is_invalid() {
        let dir = temp("invalid");
        fs::write(dir.join(BOOTSTRAP_FILE), "pas du json").unwrap();
        assert!(matches!(
            read_bootstrap(&dir),
            Err(BootstrapError::Invalid(_))
        ));
    }

    #[test]
    fn write_then_read_roundtrips_without_tmp() {
        let dir = temp("roundtrip");
        let value = Bootstrap::with_data_dir(dir.join("data"));
        write_bootstrap(&dir, &value).unwrap();
        assert_eq!(read_bootstrap(&dir).unwrap(), Some(value));
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn resume_url_is_read_once_then_cleared() {
        let dir = temp("resume");
        let mut value = Bootstrap::with_data_dir(dir.join("data"));
        value.resume_url = Some("/bienvenue?profile=pro&step=data".to_owned());
        write_bootstrap(&dir, &value).unwrap();
        assert_eq!(
            take_resume_url(&dir).unwrap().as_deref(),
            Some("/bienvenue?profile=pro&step=data")
        );
        assert_eq!(take_resume_url(&dir).unwrap(), None);
        let kept = read_bootstrap(&dir).unwrap().unwrap();
        assert_eq!(kept.data_dir, Some(dir.join("data")));
        assert_eq!(kept.resume_url, None);
    }

    #[test]
    fn resume_url_accepts_only_wizard_profile_and_step() {
        assert!(is_valid_resume_url("/bienvenue?profile=pro&step=data"));
        assert!(is_valid_resume_url("/bienvenue"));
        assert!(!is_valid_resume_url("/reglages"));
        assert!(!is_valid_resume_url("/bienvenue?profile=pro&key=abc"));
        assert!(!is_valid_resume_url("/bienvenue?profile=a b"));
    }

    #[test]
    fn validate_rejects_relative_path() {
        assert!(matches!(
            validate_data_dir(Path::new("relatif/dossier")),
            Err(BootstrapError::NotAbsolute(_))
        ));
    }

    #[test]
    fn validate_rejects_unc_path() {
        assert!(matches!(
            validate_data_dir(Path::new("\\\\serveur\\partage\\regis")),
            Err(BootstrapError::NotWritable(message)) if message.contains("réseau")
        ));
    }

    #[test]
    fn validate_rejects_foreign_non_empty_dir() {
        let dir = temp("foreign");
        fs::write(dir.join("a.txt"), "x").unwrap();
        assert!(matches!(
            validate_data_dir(&dir),
            Err(BootstrapError::NotEmptyNorRegis(_))
        ));
    }

    #[test]
    fn validate_accepts_empty_marked_and_creatable_dirs() {
        let empty = temp("empty");
        assert!(validate_data_dir(&empty).is_ok());
        let marked = temp("marked");
        fs::write(marked.join("a.txt"), "x").unwrap();
        fs::write(marked.join(DATA_DIR_MARKER), "{}").unwrap();
        assert!(validate_data_dir(&marked).is_ok());
        assert!(validate_data_dir(&empty.join("nouveau")).is_ok());
    }

    #[test]
    fn marker_is_created_once() {
        let dir = temp("marker");
        assert!(!has_marker(&dir));
        let first = ensure_marker(&dir).unwrap();
        assert!(has_marker(&dir));
        let second = ensure_marker(&dir).unwrap();
        assert_eq!(first, second);
    }
}

#[cfg(test)]
mod data_dir_tests {
    use super::*;

    fn bootstrap(dir: Option<&str>) -> Bootstrap {
        Bootstrap {
            version: 1,
            data_dir: dir.map(PathBuf::from),
            resume_url: None,
        }
    }

    #[test]
    fn env_wins_over_bootstrap_and_default() {
        let b = bootstrap(Some("Y"));
        let (dir, origin) = resolve_data_dir(Some("X".into()), Some(&b), PathBuf::from("D"));
        assert_eq!((dir, origin), (PathBuf::from("X"), DataDirOrigin::Env));
    }

    #[test]
    fn bootstrap_wins_over_default() {
        let b = bootstrap(Some("Y"));
        let (dir, origin) = resolve_data_dir(None, Some(&b), PathBuf::from("D"));
        assert_eq!(
            (dir, origin),
            (PathBuf::from("Y"), DataDirOrigin::Bootstrap)
        );
    }

    #[test]
    fn empty_env_and_null_bootstrap_fall_back_to_default() {
        let b = bootstrap(None);
        let (dir, origin) = resolve_data_dir(Some("".into()), Some(&b), PathBuf::from("D"));
        assert_eq!((dir, origin), (PathBuf::from("D"), DataDirOrigin::Default));
    }
}
