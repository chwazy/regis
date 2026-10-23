use rusqlite::types::Value;
use rusqlite::{params, Connection, Row};

use super::{
    column_enum, column_json, enum_text, json_text, list_where, new_id, opt_text, text, Record,
    RepoError,
};
use regis_model::{Item, ItemKind, ItemUpsert};

impl Record for Item {
    const TABLE: &'static str = "items";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "connector_id",
        "kind",
        "external_id",
        "title",
        "body_text",
        "occurred_at",
        "data_json",
        "updated_at",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Item {
            id: row.get("id")?,
            connector_id: row.get("connector_id")?,
            kind: column_enum(row, "kind")?,
            external_id: row.get("external_id")?,
            title: row.get("title")?,
            body_text: row.get("body_text")?,
            occurred_at: row.get("occurred_at")?,
            data_json: column_json(row, "data_json")?,
            updated_at: row.get("updated_at")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.connector_id),
            enum_text(&self.kind)?,
            text(&self.external_id),
            text(&self.title),
            opt_text(&self.body_text),
            opt_text(&self.occurred_at),
            json_text(&self.data_json),
            text(&self.updated_at),
        ])
    }
}

#[derive(Debug, Default, Clone)]
pub struct ItemFilter {
    pub kind: Option<ItemKind>,
    pub connector_id: Option<String>,
    pub since: Option<String>,
    pub limit: Option<i64>,
}

pub fn upsert_items(conn: &mut Connection, items: &[ItemUpsert]) -> Result<usize, RepoError> {
    let tx = conn.transaction()?;
    {
        let mut statement = tx.prepare(
            "INSERT INTO items (id, connector_id, kind, external_id, title, body_text, occurred_at, data_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (connector_id, kind, external_id) DO UPDATE SET
               title = excluded.title, body_text = excluded.body_text, occurred_at = excluded.occurred_at,
               data_json = excluded.data_json, updated_at = excluded.updated_at",
        )?;
        for item in items {
            statement.execute(params![
                new_id(),
                item.connector_id,
                enum_text(&item.kind)?,
                item.external_id,
                item.title,
                item.body_text,
                item.occurred_at,
                item.data_json.to_string(),
                item.updated_at,
            ])?;
        }
    }
    tx.commit()?;
    Ok(items.len())
}

pub fn list_items(conn: &Connection, filter: &ItemFilter) -> Result<Vec<Item>, RepoError> {
    let mut conditions: Vec<&str> = vec!["1 = 1"];
    let mut values: Vec<Value> = Vec::new();
    if let Some(kind) = filter.kind {
        values.push(enum_text(&kind)?);
        conditions.push("kind = ?");
    }
    if let Some(connector_id) = &filter.connector_id {
        values.push(text(connector_id));
        conditions.push("connector_id = ?");
    }
    if let Some(since) = &filter.since {
        values.push(text(since));
        conditions.push("updated_at >= ?");
    }
    let condition = conditions.join(" AND ");
    let order = match filter.limit {
        Some(limit) => format!("occurred_at DESC, rowid DESC LIMIT {}", limit.max(0)),
        None => "occurred_at DESC, rowid DESC".to_owned(),
    };
    list_where(conn, &condition, &order, values)
}
