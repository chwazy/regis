use std::path::{Component, Path, PathBuf};
use std::process::Command;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::indexer::load_max_file_bytes;
use super::sources::{
    generated_dir, models_dir, regis_source, register_imported, unique_destination, SourceError,
};
use super::watcher::register_file;
use crate::db::repo::{self, RepoError};
use crate::db::Db;
use crate::events::now_iso_utc;
use regis_model::{Entity, FileEntry, Template};

const TEMPLATE_EXTENSIONS: [&str; 4] = ["docx", "md", "txt", "xlsx"];
const RECENT_USES_LIMIT: i64 = 5;
const REL_GENERATED_BY: &str = "generated_by";
const REL_GENERATED_FROM: &str = "generated_from";
const REL_GENERATED_FOR: &str = "generated_for";

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TemplateUse {
    pub file_id: String,
    pub file_name: String,
    pub job_id: Option<String>,
    pub job_title: Option<String>,
    pub job_status: Option<String>,
    pub used_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub template: Template,
    pub file: FileEntry,
    #[ts(type = "number")]
    pub usage_count: i64,
    pub recent_uses: Vec<TemplateUse>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePatch {
    pub name: Option<String>,
    pub instructions: Option<String>,
    pub variables_json: Option<serde_json::Value>,
    pub version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    pub rel_path: String,
    pub template_id: String,
    pub job_id: String,
    pub entity_id: Option<String>,
}

fn file_stem(rel_path: &str) -> String {
    Path::new(rel_path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel_path.to_owned())
}

pub fn sync_templates(db: &Db) -> Result<(), RepoError> {
    db.with_conn(|conn| {
        let orphans: Vec<FileEntry> = repo::list_where(
            conn,
            "role = 'template' AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.file_id = files.id)",
            "rowid",
            Vec::new(),
        )?;
        for file in orphans {
            repo::upsert(
                conn,
                &Template {
                    id: repo::new_id(),
                    file_id: file.id,
                    name: file_stem(&file.rel_path),
                    instructions: String::new(),
                    variables_json: serde_json::json!([]),
                    version: 1,
                },
            )?;
        }
        Ok(())
    })
}

pub fn list_summaries(db: &Db) -> Result<Vec<TemplateSummary>, RepoError> {
    sync_templates(db)?;
    db.with_conn(|conn| {
        let templates: Vec<Template> =
            repo::list_where(conn, "1 = 1", "name COLLATE NOCASE", Vec::new())?;
        templates
            .into_iter()
            .map(|template| summarize(conn, template))
            .collect()
    })
}

pub fn get_summary(db: &Db, template_id: &str) -> Result<TemplateSummary, RepoError> {
    db.with_conn(|conn| {
        let template: Template = repo::require(conn, template_id)?;
        summarize(conn, template)
    })
}

fn summarize(conn: &Connection, template: Template) -> Result<TemplateSummary, RepoError> {
    let file: FileEntry = repo::require(conn, &template.file_id)?;
    let usage_count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT COALESCE(lj.to_id, f.id))
         FROM links lt JOIN files f ON f.id = lt.from_id
         LEFT JOIN links lj ON lj.from_type = 'file' AND lj.from_id = f.id AND lj.to_type = 'job' AND lj.rel = ?2
         WHERE lt.from_type = 'file' AND lt.to_type = 'template' AND lt.to_id = ?1",
        params![template.id, REL_GENERATED_BY],
        |row| row.get(0),
    )?;
    let mut statement = conn.prepare(
        "SELECT MIN(f.id), MIN(f.rel_path), lj.to_id, j.title, j.status, MAX(lt.created_at)
         FROM links lt JOIN files f ON f.id = lt.from_id
         LEFT JOIN links lj ON lj.from_type = 'file' AND lj.from_id = f.id AND lj.to_type = 'job' AND lj.rel = ?2
         LEFT JOIN jobs j ON j.id = lj.to_id
         WHERE lt.from_type = 'file' AND lt.to_type = 'template' AND lt.to_id = ?1
         GROUP BY COALESCE(lj.to_id, f.id)
         ORDER BY MAX(lt.created_at) DESC LIMIT ?3",
    )?;
    let recent_uses = statement
        .query_map(
            params![template.id, REL_GENERATED_BY, RECENT_USES_LIMIT],
            |row| {
                Ok(TemplateUse {
                    file_id: row.get(0)?,
                    file_name: row.get(1)?,
                    job_id: row.get(2)?,
                    job_title: row.get(3)?,
                    job_status: row.get(4)?,
                    used_at: row.get(5)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(TemplateSummary {
        template,
        file,
        usage_count,
        recent_uses,
    })
}

pub fn update_template(
    db: &Db,
    template_id: &str,
    patch: &TemplatePatch,
) -> Result<Template, RepoError> {
    db.with_conn(|conn| {
        let mut template: Template = repo::require(conn, template_id)?;
        if let Some(name) = &patch.name {
            let name = name.trim();
            if name.is_empty() {
                return Err(RepoError::Invalid("the template name is empty".to_owned()));
            }
            template.name = name.to_owned();
        }
        if let Some(instructions) = &patch.instructions {
            template.instructions = instructions.clone();
        }
        if let Some(variables) = &patch.variables_json {
            if !variables.is_array() {
                return Err(RepoError::Invalid("variables must be an array".to_owned()));
            }
            template.variables_json = variables.clone();
        }
        if let Some(version) = patch.version {
            template.version = version;
        }
        repo::upsert(conn, &template)?;
        Ok(template)
    })
}

pub fn import_template(db: &Db, data_dir: &Path, raw_path: &str) -> Result<Template, SourceError> {
    let origin = Path::new(raw_path);
    let file_name = origin
        .file_name()
        .ok_or_else(|| SourceError::Invalid("the file path is empty".to_owned()))?;
    let extension = origin
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !origin.is_file() || !TEMPLATE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(SourceError::Invalid(
            "a template must be a DOCX, Markdown, text or XLSX file".to_owned(),
        ));
    }
    let target_dir = models_dir(data_dir);
    std::fs::create_dir_all(&target_dir)?;
    let source = regis_source(db, &target_dir)?;
    let destination = unique_destination(&target_dir, file_name.to_string_lossy().as_ref());
    std::fs::copy(origin, &destination)?;
    let file = register_imported(db, &source, &destination)?;
    let template = Template {
        id: repo::new_id(),
        file_id: file.id,
        name: file_stem(&file.rel_path),
        instructions: String::new(),
        variables_json: serde_json::json!([]),
        version: 1,
    };
    db.with_conn(|conn| repo::upsert(conn, &template))?;
    Ok(template)
}

pub fn template_path(db: &Db, data_dir: &Path, template_id: &str) -> Result<PathBuf, SourceError> {
    let file: FileEntry = db.with_conn(|conn| {
        let template: Template = repo::require(conn, template_id)?;
        repo::require(conn, &template.file_id)
    })?;
    Ok(models_dir(data_dir).join(file.rel_path))
}

pub fn open_with_default_app(path: &Path) -> Result<(), SourceError> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer.exe");
        command.arg(path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };
    command.spawn()?;
    Ok(())
}

fn insert_link(
    conn: &Connection,
    file_id: &str,
    to_type: &str,
    to_id: &str,
    rel: &str,
) -> Result<(), RepoError> {
    conn.execute(
        "INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, confidence, created_at)
         VALUES (?1, 'file', ?2, ?3, ?4, ?5, 'user', NULL, ?6)
         ON CONFLICT (from_type, from_id, to_type, to_id, rel) DO NOTHING",
        params![repo::new_id(), file_id, to_type, to_id, rel, now_iso_utc()],
    )?;
    Ok(())
}

fn is_safe_relative(rel_path: &str) -> bool {
    !rel_path.is_empty()
        && Path::new(rel_path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

pub fn register_generated(
    db: &Db,
    data_dir: &Path,
    generated: &GeneratedFile,
) -> Result<FileEntry, SourceError> {
    if !is_safe_relative(&generated.rel_path) {
        return Err(SourceError::Invalid(
            "the generated file path is invalid".to_owned(),
        ));
    }
    let target_dir = generated_dir(data_dir);
    let metadata = std::fs::metadata(target_dir.join(&generated.rel_path))?;
    let source = regis_source(db, &target_dir)?;
    let max_bytes = load_max_file_bytes(db);
    let entry = db.with_conn(|conn| {
        repo::require::<Template>(conn, &generated.template_id)?;
        if let Some(entity_id) = &generated.entity_id {
            repo::require::<Entity>(conn, entity_id)?;
        }
        let (entry, _) = register_file(conn, &source, &generated.rel_path, &metadata, max_bytes)?;
        insert_link(conn, &entry.id, "job", &generated.job_id, REL_GENERATED_BY)?;
        insert_link(
            conn,
            &entry.id,
            "template",
            &generated.template_id,
            REL_GENERATED_FROM,
        )?;
        if let Some(entity_id) = &generated.entity_id {
            insert_link(conn, &entry.id, "entity", entity_id, REL_GENERATED_FOR)?;
        }
        Ok(entry)
    })?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::testing::test_db;
    use crate::files::sources::ensure_regis_sources;
    use regis_model::EntityKind;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "regis-templates-test-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn seed(name: &str) -> (Db, PathBuf, Template) {
        let db = test_db(name);
        let data_dir = temp_dir(name);
        ensure_regis_sources(&db, &data_dir).expect("regis sources");
        let origin = data_dir.join("relance.md");
        std::fs::write(&origin, "Bonjour {{client.nom}}").expect("write template");
        let template =
            import_template(&db, &data_dir, &origin.to_string_lossy()).expect("import template");
        (db, data_dir, template)
    }

    fn client(db: &Db) -> Entity {
        let entity = Entity {
            id: repo::new_id(),
            kind: EntityKind::Client,
            name: "Atelier Rhône SA".to_owned(),
            tags_json: serde_json::json!([]),
            data_json: serde_json::json!({}),
            created_at: now_iso_utc(),
            updated_at: now_iso_utc(),
        };
        db.with_conn(|conn| repo::upsert(conn, &entity))
            .expect("entity");
        entity
    }

    #[test]
    fn imported_template_is_listed_with_role_template_and_no_usage() {
        let (db, data_dir, template) = seed("tpl-import");

        let summaries = list_summaries(&db).expect("summaries");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].template.id, template.id);
        assert_eq!(summaries[0].file.role, "template");
        assert_eq!(summaries[0].template.name, "relance");
        assert_eq!(summaries[0].usage_count, 0);
        assert!(data_dir.join("library/models/relance.md").is_file());
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn generated_file_is_linked_to_entity_job_and_template() {
        let (db, data_dir, template) = seed("tpl-generated");
        let entity = client(&db);
        let target = data_dir.join("library/generated/J1");
        std::fs::create_dir_all(&target).expect("job dir");
        std::fs::write(target.join("relance.md"), "Bonjour Atelier").expect("generated file");

        let entry = register_generated(
            &db,
            &data_dir,
            &GeneratedFile {
                rel_path: "J1/relance.md".to_owned(),
                template_id: template.id.clone(),
                job_id: "J1".to_owned(),
                entity_id: Some(entity.id.clone()),
            },
        )
        .expect("register");

        assert_eq!(entry.role, "generated");
        let card = db
            .with_conn(|conn| repo::entity_card(conn, &entity.id))
            .expect("card");
        assert!(card
            .documents
            .iter()
            .any(|document| document.file_id == entry.id));
        let summary = get_summary(&db, &template.id).expect("summary");
        assert_eq!(summary.usage_count, 1);
        assert_eq!(summary.recent_uses[0].job_id.as_deref(), Some("J1"));
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn generated_path_cannot_leave_the_generated_folder() {
        let (db, data_dir, template) = seed("tpl-escape");

        let outcome = register_generated(
            &db,
            &data_dir,
            &GeneratedFile {
                rel_path: "../models/relance.md".to_owned(),
                template_id: template.id,
                job_id: "J1".to_owned(),
                entity_id: None,
            },
        );

        assert!(outcome.is_err());
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn variables_patch_persists_and_must_be_an_array() {
        let (db, data_dir, template) = seed("tpl-patch");

        let updated = update_template(
            &db,
            &template.id,
            &TemplatePatch {
                variables_json: Some(serde_json::json!([{ "key": "client.nom", "source": "ask" }])),
                ..TemplatePatch::default()
            },
        )
        .expect("update");

        assert_eq!(updated.variables_json[0]["source"], "ask");
        let rejected = update_template(
            &db,
            &template.id,
            &TemplatePatch {
                variables_json: Some(serde_json::json!({})),
                ..TemplatePatch::default()
            },
        );
        assert!(rejected.is_err());
        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
