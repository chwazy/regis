use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::bootstrap::{self, resolve_data_dir, DataDirOrigin, DATA_DIR_MARKER};
use crate::db::DATABASE_FILE;
use crate::secrets::SecretError;

pub const UNINSTALL_FLAG: &str = "--uninstall-cleanup";
pub const UNINSTALL_LOG: &str = "regis-uninstall.log";

#[derive(Debug, Clone, PartialEq)]
pub struct CleanupPlan {
    pub secret_refs: Vec<String>,
    pub delete_data_dir: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum UninstallError {
    #[error("lecture de la base impossible : {0}")]
    Db(String),
    #[error(transparent)]
    Bootstrap(#[from] crate::bootstrap::BootstrapError),
    #[error(transparent)]
    Secret(#[from] crate::secrets::SecretError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Pure : décide quoi supprimer, sans rien toucher.
pub fn plan_cleanup(
    origin: DataDirOrigin,
    data_dir: &Path,
    has_marker: bool,
    mut secret_refs: Vec<String>,
) -> CleanupPlan {
    secret_refs.sort();
    secret_refs.dedup();
    let delete_data_dir =
        (origin == DataDirOrigin::Bootstrap && has_marker).then(|| data_dir.to_path_buf());
    CleanupPlan {
        secret_refs,
        delete_data_dir,
    }
}

pub fn is_uninstall_invocation(args: &[OsString]) -> bool {
    args.iter().skip(1).any(|arg| arg == UNINSTALL_FLAG)
}

#[derive(Default)]
struct Report {
    lines: Vec<String>,
}

impl Report {
    fn step(&mut self, line: impl Into<String>) {
        self.lines.push(line.into());
    }

    fn write(&self, path: &Path) {
        let mut text = self.lines.join("\n");
        text.push('\n');
        let _ = fs::write(path, text);
    }
}

fn read_secret_refs(db_path: &Path, report: &mut Report) -> Vec<String> {
    if !db_path.is_file() {
        report.step("base absente : aucun secret à supprimer");
        return Vec::new();
    }
    let mut refs = Vec::new();
    for table in ["connectors", "agents"] {
        match query_refs(db_path, table) {
            Ok(found) => {
                report.step(format!("{table} : {} référence(s) de secret", found.len()));
                refs.extend(found);
            }
            Err(error) => report.step(format!("{table} : lecture ignorée ({error})")),
        }
    }
    refs
}

fn query_refs(db_path: &Path, table: &str) -> Result<Vec<String>, UninstallError> {
    let db_error = |error: rusqlite::Error| UninstallError::Db(error.to_string());
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(db_error)?;
    let sql = format!("SELECT secret_ref FROM {table} WHERE secret_ref IS NOT NULL");
    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?;
    let mut refs = Vec::new();
    for row in rows {
        let value = row.map_err(db_error)?;
        if !value.is_empty() {
            refs.push(value);
        }
    }
    Ok(refs)
}

fn is_safe_to_delete(dir: &Path) -> bool {
    dir.is_absolute() && dir.parent().is_some() && dir.is_dir()
}

fn execute(
    config_dir: &Path,
    default_data_dir: &Path,
    delete_secret: &dyn Fn(&str) -> Result<(), SecretError>,
    report: &mut Report,
) -> CleanupPlan {
    let bootstrap = match bootstrap::read_bootstrap(config_dir) {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            report.step(format!("bootstrap.json ignoré : {error}"));
            None
        }
    };
    let (data_dir, origin) =
        resolve_data_dir(None, bootstrap.as_ref(), default_data_dir.to_path_buf());
    report.step(format!(
        "dossier de données : {} (origine {origin:?})",
        data_dir.display()
    ));
    let secret_refs = read_secret_refs(&data_dir.join(DATABASE_FILE), report);
    let marker = bootstrap::has_marker(&data_dir);
    let plan = plan_cleanup(origin, &data_dir, marker, secret_refs);

    for secret_ref in &plan.secret_refs {
        match delete_secret(secret_ref) {
            Ok(()) => report.step(format!("coffre : entrée {secret_ref} supprimée")),
            Err(error) => report.step(format!("coffre : {secret_ref} non supprimée ({error})")),
        }
    }
    match &plan.delete_data_dir {
        Some(dir) if is_safe_to_delete(dir) => match fs::remove_dir_all(dir) {
            Ok(()) => report.step(format!("dossier de données supprimé : {}", dir.display())),
            Err(error) => report.step(format!("suppression impossible : {error}")),
        },
        Some(dir) => report.step(format!("suppression refusée : {}", dir.display())),
        None => report.step(format!(
            "dossier de données conservé (origine {origin:?}, marqueur {DATA_DIR_MARKER} : {marker})"
        )),
    }
    plan
}

/// Variante injectable (coffre et journal) de [`run_cleanup`].
pub fn run_cleanup_with(
    config_dir: &Path,
    default_data_dir: &Path,
    log_path: &Path,
    delete_secret: &dyn Fn(&str) -> Result<(), SecretError>,
) -> Result<CleanupPlan, UninstallError> {
    let mut report = Report::default();
    report.step("nettoyage de désinstallation");
    let plan = execute(config_dir, default_data_dir, delete_secret, &mut report);
    report.write(log_path);
    Ok(plan)
}

/// Exécute le plan ; journalise chaque étape (sans valeur de secret) ; ne panique jamais.
pub fn run_cleanup(
    config_dir: &Path,
    default_data_dir: &Path,
) -> Result<CleanupPlan, UninstallError> {
    run_cleanup_with(
        config_dir,
        default_data_dir,
        &std::env::temp_dir().join(UNINSTALL_LOG),
        &crate::secrets::delete_installed_secret,
    )
}

/// Point d'entrée du mode CLI : ne signale jamais d'échec (code de sortie 0).
pub fn run_cli(identifier: &str) {
    let log_path = std::env::temp_dir().join(UNINSTALL_LOG);
    match application_dirs(identifier) {
        Some((config_dir, data_dir)) => {
            if let Err(error) = run_cleanup(&config_dir, &data_dir) {
                let _ = fs::write(&log_path, format!("nettoyage en échec : {error}\n"));
            }
        }
        None => {
            let _ = fs::write(&log_path, "dossiers de l'application introuvables\n");
        }
    }
}

#[cfg(windows)]
fn application_dirs(identifier: &str) -> Option<(PathBuf, PathBuf)> {
    let base = std::env::var_os("APPDATA").filter(|value| !value.is_empty())?;
    let dir = PathBuf::from(base).join(identifier);
    Some((dir.clone(), dir))
}

#[cfg(not(windows))]
fn application_dirs(_identifier: &str) -> Option<(PathBuf, PathBuf)> {
    None
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "regis-uninstall-{}-{name}-{}",
            std::process::id(),
            ulid::Ulid::generate()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn refs(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn plan_dedups_sorts_and_deletes_marked_bootstrap_dir() {
        let dir = PathBuf::from("D");
        let plan = plan_cleanup(DataDirOrigin::Bootstrap, &dir, true, refs(&["b", "a", "a"]));
        assert_eq!(plan.secret_refs, refs(&["a", "b"]));
        assert_eq!(plan.delete_data_dir, Some(dir));
    }

    #[test]
    fn plan_keeps_unmarked_or_default_dirs() {
        let dir = PathBuf::from("D");
        let unmarked = plan_cleanup(DataDirOrigin::Bootstrap, &dir, false, refs(&["a"]));
        assert_eq!(unmarked.delete_data_dir, None);
        let default = plan_cleanup(DataDirOrigin::Default, &dir, true, refs(&["a"]));
        assert_eq!(default.delete_data_dir, None);
    }

    #[test]
    fn invocation_flag_detection() {
        let flagged: Vec<OsString> = vec!["regis.exe".into(), UNINSTALL_FLAG.into()];
        let plain: Vec<OsString> = vec!["regis.exe".into()];
        assert!(is_uninstall_invocation(&flagged));
        assert!(!is_uninstall_invocation(&plain));
    }

    struct Fixture {
        config: PathBuf,
        data: PathBuf,
        log: PathBuf,
    }

    fn fixture(name: &str, with_marker: bool) -> Fixture {
        let root = temp(name);
        let config = root.join("config");
        let data = root.join("custom-data");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&data).unwrap();
        bootstrap::write_bootstrap(&config, &bootstrap::Bootstrap::with_data_dir(data.clone()))
            .unwrap();
        if with_marker {
            fs::write(data.join(DATA_DIR_MARKER), "{}").unwrap();
        }
        let connection = Connection::open(data.join(DATABASE_FILE)).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE connectors (id TEXT, secret_ref TEXT);
                 CREATE TABLE agents (id TEXT, secret_ref TEXT);
                 INSERT INTO connectors VALUES ('c1', 'odoo/key'), ('c2', 'm365/token'), ('c3', NULL);",
            )
            .unwrap();
        drop(connection);
        Fixture {
            config,
            data,
            log: root.join("uninstall.log"),
        }
    }

    fn vault() -> RefCell<HashMap<String, String>> {
        RefCell::new(HashMap::from([
            ("odoo/key".to_owned(), "S3CRET-TEST".to_owned()),
            ("m365/token".to_owned(), "S3CRET-TEST".to_owned()),
            ("other".to_owned(), "keep".to_owned()),
        ]))
    }

    #[test]
    fn cleanup_removes_marked_data_dir_and_vault_entries_without_leaking() {
        let fx = fixture("full", true);
        let vault = vault();
        let delete = |secret_ref: &str| {
            vault.borrow_mut().remove(secret_ref);
            Ok(())
        };
        let default_dir = fx.config.join("unused-default");
        let plan = run_cleanup_with(&fx.config, &default_dir, &fx.log, &delete).unwrap();
        assert_eq!(plan.secret_refs, refs(&["m365/token", "odoo/key"]));
        assert!(!fx.data.exists());
        let remaining: Vec<String> = vault.borrow().keys().cloned().collect();
        assert_eq!(remaining, refs(&["other"]));
        let log = fs::read_to_string(&fx.log).unwrap();
        assert!(!log.contains("S3CRET-TEST"));
        assert!(log.contains("odoo/key"));
    }

    #[test]
    fn cleanup_keeps_data_dir_without_marker() {
        let fx = fixture("nomarker", false);
        let default_dir = fx.config.join("unused-default");
        let plan = run_cleanup_with(&fx.config, &default_dir, &fx.log, &|_| Ok(())).unwrap();
        assert_eq!(plan.delete_data_dir, None);
        assert!(fx.data.join(DATABASE_FILE).is_file());
    }

    #[test]
    fn cleanup_without_db_nor_bootstrap_is_empty_ok() {
        let root = temp("empty");
        let default_dir = root.join("data");
        let log = root.join("l.log");
        let plan = run_cleanup_with(&root.join("config"), &default_dir, &log, &|_| Ok(())).unwrap();
        assert_eq!(
            plan,
            CleanupPlan {
                secret_refs: Vec::new(),
                delete_data_dir: None
            }
        );
    }

    #[test]
    fn vault_failure_does_not_fail_cleanup() {
        let fx = fixture("vaultfail", true);
        let delete = |_: &str| Err(SecretError::Store("boom".to_owned()));
        let default_dir = fx.config.join("unused-default");
        let plan = run_cleanup_with(&fx.config, &default_dir, &fx.log, &delete).unwrap();
        assert_eq!(plan.secret_refs.len(), 2);
        assert!(!fx.data.exists());
    }
}
