use rusqlite::types::Value;
use rusqlite::Row;

use super::{column_enum, column_json, enum_text, json_text, opt_real, text, Record, RepoError};
use regis_model::{Entity, Fact, Link};

impl Record for Entity {
    const TABLE: &'static str = "entities";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "kind",
        "name",
        "tags_json",
        "data_json",
        "created_at",
        "updated_at",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Entity {
            id: row.get("id")?,
            kind: column_enum(row, "kind")?,
            name: row.get("name")?,
            tags_json: column_json(row, "tags_json")?,
            data_json: column_json(row, "data_json")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            enum_text(&self.kind)?,
            text(&self.name),
            json_text(&self.tags_json),
            json_text(&self.data_json),
            text(&self.created_at),
            text(&self.updated_at),
        ])
    }
}

impl Record for Link {
    const TABLE: &'static str = "links";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "from_type",
        "from_id",
        "to_type",
        "to_id",
        "rel",
        "origin",
        "confidence",
        "created_at",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Link {
            id: row.get("id")?,
            from_type: row.get("from_type")?,
            from_id: row.get("from_id")?,
            to_type: row.get("to_type")?,
            to_id: row.get("to_id")?,
            rel: row.get("rel")?,
            origin: row.get("origin")?,
            confidence: row.get("confidence")?,
            created_at: row.get("created_at")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.from_type),
            text(&self.from_id),
            text(&self.to_type),
            text(&self.to_id),
            text(&self.rel),
            text(&self.origin),
            opt_real(self.confidence),
            text(&self.created_at),
        ])
    }
}

impl Record for Fact {
    const TABLE: &'static str = "facts";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "entity_id",
        "text",
        "source_type",
        "source_id",
        "status",
        "created_at",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Fact {
            id: row.get("id")?,
            entity_id: row.get("entity_id")?,
            text: row.get("text")?,
            source_type: row.get("source_type")?,
            source_id: row.get("source_id")?,
            status: column_enum(row, "status")?,
            created_at: row.get("created_at")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.entity_id),
            text(&self.text),
            text(&self.source_type),
            text(&self.source_id),
            enum_text(&self.status)?,
            text(&self.created_at),
        ])
    }
}
