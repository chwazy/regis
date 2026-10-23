use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;

use crate::sidecar::{HostError, SidecarClient};

const KEYRING_SERVICE: &str = "regis";
const DEMO_KEYRING_SERVICE: &str = "regis-demo";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("the OS secret store is unavailable: {0}")]
    Unavailable(String),
    #[error("secret store error: {0}")]
    Store(String),
}

impl From<keyring::Error> for SecretError {
    fn from(error: keyring::Error) -> Self {
        match error {
            keyring::Error::NoDefaultStore | keyring::Error::NoStorageAccess(_) => {
                SecretError::Unavailable(error.to_string())
            }
            other => SecretError::Store(other.to_string()),
        }
    }
}

fn entry(secret_ref: &str) -> Result<keyring::Entry, SecretError> {
    let service = if crate::demo::is_enabled() {
        DEMO_KEYRING_SERVICE
    } else {
        KEYRING_SERVICE
    };
    Ok(keyring::Entry::new(service, secret_ref)?)
}

pub fn set_secret(secret_ref: &str, value: &str) -> Result<(), SecretError> {
    Ok(entry(secret_ref)?.set_password(value)?)
}

pub fn get_secret(secret_ref: &str) -> Result<Option<String>, SecretError> {
    match entry(secret_ref)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn delete_secret(secret_ref: &str) -> Result<(), SecretError> {
    match entry(secret_ref)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Suppression pour la désinstallation : toujours le coffre de production, jamais celui de démo.
pub fn delete_installed_secret(secret_ref: &str) -> Result<(), SecretError> {
    match keyring::Entry::new(KEYRING_SERVICE, secret_ref)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetSecretParams {
    secret_ref: String,
}

pub fn register_host_methods(sidecar: &SidecarClient) {
    sidecar.register_host_method(
        "secrets.get",
        Arc::new(|params| {
            Box::pin(async move {
                let params: GetSecretParams = serde_json::from_value(params)
                    .map_err(|error| HostError::InvalidParams(error.to_string()))?;
                let value = get_secret(&params.secret_ref)
                    .map_err(|error| HostError::Internal(error.to_string()))?;
                Ok(json!({ "value": value }))
            })
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_store_maps_to_unavailable() {
        let error = SecretError::from(keyring::Error::NoDefaultStore);
        assert!(matches!(error, SecretError::Unavailable(_)));
    }

    #[test]
    #[ignore = "requires the OS secret store"]
    fn roundtrip() {
        let secret_ref = format!("test/roundtrip-{}", std::process::id());
        set_secret(&secret_ref, "s3cret").expect("set");
        let stored = get_secret(&secret_ref);
        let deleted = delete_secret(&secret_ref);
        let after_delete = get_secret(&secret_ref);
        assert_eq!(stored.expect("get"), Some("s3cret".to_owned()));
        deleted.expect("delete");
        assert_eq!(after_delete.expect("get after delete"), None);
    }
}
