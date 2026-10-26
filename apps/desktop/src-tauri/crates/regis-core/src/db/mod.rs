pub mod repo;

use std::path::Path;
use std::sync::{Mutex, MutexGuard, Once};

use rusqlite::{ffi, Connection};

use repo::RepoError;

pub const DATABASE_FILE: &str = "regis.sqlite";

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
    rebuilds_tables: bool,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "0001_init",
        sql: include_str!("migrations/0001_init.sql"),
        rebuilds_tables: false,
    },
    Migration {
        version: 2,
        name: "0002_reference_sources",
        sql: include_str!("migrations/0002_reference_sources.sql"),
        rebuilds_tables: false,
    },
    Migration {
        version: 3,
        name: "0003_entity_resources",
        sql: include_str!("migrations/0003_entity_resources.sql"),
        rebuilds_tables: false,
    },
];

type AutoExtensionInit = unsafe extern "C" fn(
    *mut ffi::sqlite3,
    *mut *mut std::os::raw::c_char,
    *const ffi::sqlite3_api_routines,
) -> std::os::raw::c_int;

static REGISTER_VEC: Once = Once::new();

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Db, DbError> {
        register_sqlite_vec();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        apply_migrations(&conn, MIGRATIONS)?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    pub fn schema_version(&self) -> Result<i64, DbError> {
        let version = self.lock().query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        Ok(version)
    }

    pub fn vec_version(&self) -> Result<String, DbError> {
        let version = self
            .lock()
            .query_row("SELECT vec_version()", [], |row| row.get(0))?;
        Ok(version)
    }

    pub fn with_conn<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, RepoError>,
    ) -> Result<T, RepoError> {
        operation(&mut self.lock())
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn register_sqlite_vec() {
    REGISTER_VEC.call_once(|| {
        // SAFETY: sqlite3_vec_init has the sqlite3 auto-extension entry point signature
        // and is registered exactly once, before any connection is opened.
        unsafe {
            let init = std::mem::transmute::<*const (), AutoExtensionInit>(
                sqlite_vec::sqlite3_vec_init as *const (),
            );
            ffi::sqlite3_auto_extension(Some(init));
        }
    });
}

fn apply_migrations(conn: &Connection, migrations: &[Migration]) -> Result<(), DbError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            checksum   TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );",
    )?;
    for migration in migrations {
        let expected = checksum(migration.sql);
        let applied: Option<String> = conn
            .query_row(
                "SELECT checksum FROM schema_migrations WHERE version = ?1",
                [migration.version],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        match applied {
            Some(existing) if existing == expected => {}
            Some(_) => {
                return Err(DbError::Migration(format!(
                    "migration {} was modified after being applied",
                    migration.name
                )))
            }
            None => apply_one(conn, migration, &expected)?,
        }
    }
    Ok(())
}

fn apply_one(conn: &Connection, migration: &Migration, checksum: &str) -> Result<(), DbError> {
    if migration.rebuilds_tables {
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let applied = apply_in_transaction(conn, migration, checksum);
        conn.pragma_update(None, "foreign_keys", "ON")?;
        return applied;
    }
    apply_in_transaction(conn, migration, checksum)
}

fn apply_in_transaction(
    conn: &Connection,
    migration: &Migration,
    checksum: &str,
) -> Result<(), DbError> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(migration.sql)
        .map_err(|error| DbError::Migration(format!("{} failed: {error}", migration.name)))?;
    tx.execute(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        rusqlite::params![migration.version, migration.name, checksum],
    )?;
    if migration.rebuilds_tables {
        let violations: i64 =
            tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })?;
        if violations > 0 {
            return Err(DbError::Migration(format!(
                "{} left {violations} foreign key violation(s)",
                migration.name
            )));
        }
    }
    tx.commit()?;
    Ok(())
}

fn checksum(sql: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let normalized = sql.replace("\r\n", "\n");
    let hash = normalized.bytes().fold(FNV_OFFSET, |acc, byte| {
        (acc ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    });
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("regis-db-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("regis.sqlite")
    }

    #[test]
    fn open_applies_migrations_and_loads_vec() {
        let path = temp_db_path("migrations");
        let db = Db::open(&path).expect("open db");
        assert_eq!(db.schema_version().expect("schema version"), 3);
        let vec_version = db.vec_version().expect("vec version");
        assert!(
            vec_version.starts_with('v'),
            "unexpected vec_version: {vec_version}"
        );
        drop(db);
        let reopened = Db::open(&path).expect("reopen db");
        assert_eq!(reopened.schema_version().expect("schema version"), 3);
    }

    #[test]
    fn migrations_create_all_tables() {
        let db = Db::open(&temp_db_path("core-tables")).expect("open db");
        let expected = [
            "connectors",
            "items",
            "entities",
            "links",
            "facts",
            "entity_resources",
            "file_sources",
            "files",
            "chunks",
            "templates",
            "agents",
            "routing_rules",
            "tool_policies",
            "jobs",
            "job_events",
            "approvals",
            "briefs",
            "dashboards",
            "widgets",
            "chunks_fts",
            "chunks_vec",
            "entity_syntheses",
            "recordings",
            "transcript_segments",
        ];
        let present: Vec<String> = {
            let conn = db.lock();
            let mut statement = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .expect("prepare");
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query");
            rows.collect::<Result<_, _>>().expect("rows")
        };
        for table in expected {
            assert!(present.iter().any(|name| name == table), "missing {table}");
        }
    }

    #[test]
    fn connections_enforce_foreign_keys_and_busy_timeout() {
        let db = Db::open(&temp_db_path("pragmas")).expect("open db");
        let conn = db.lock();
        let foreign_keys: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys");
        let busy_timeout: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy_timeout");
        assert_eq!((foreign_keys, busy_timeout), (1, 5000));
    }

    #[test]
    fn fts5_available() {
        let db = Db::open(&temp_db_path("fts5")).expect("open db");
        let used: i64 = db
            .lock()
            .query_row(
                "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
                [],
                |row| row.get(0),
            )
            .expect("compile option query");
        assert_eq!(used, 1);
    }

    #[test]
    fn checksum_ignores_line_endings() {
        assert_eq!(checksum("a\r\nb\r\n"), checksum("a\nb\n"));
    }
}
