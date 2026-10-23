use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::Deserialize;
use serde_json::{json, Value};

use super::shift_day;

const MIN_LIMIT: u32 = 1;
const MAX_LIMIT: u32 = 50;
const DEFAULT_LIMIT: u32 = 10;
const MAX_FILTERS: usize = 5;
const UNGROUPED_LABEL: &str = "Total";
const MISSING_LABEL: &str = "Sans valeur";
const MAX_WITHIN_DAYS: i64 = 3660;
const CALENDAR_DATE_LENGTH: usize = 10;

#[derive(Debug, thiserror::Error)]
pub enum CustomQueryError {
    #[error("unknown field: {0}")]
    UnknownField(String),
    #[error("invalid aggregate: sum needs a numeric field")]
    InvalidAggregate,
    #[error("invalid filter: {0}")]
    InvalidFilter(String),
    #[error("too many filters (max {MAX_FILTERS})")]
    TooManyFilters,
    #[error("invalid widget spec: {0}")]
    InvalidSpec(String),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomItemKind {
    Message,
    Event,
    Task,
    TimeEntry,
    Invoice,
    Project,
    Partner,
}

impl CustomItemKind {
    fn column_value(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Event => "event",
            Self::Task => "task",
            Self::TimeEntry => "time_entry",
            Self::Invoice => "invoice",
            Self::Project => "project",
            Self::Partner => "partner",
        }
    }

    fn data_fields(self) -> &'static [&'static str] {
        match self {
            Self::Message => &[
                "isRead",
                "importance",
                "conversationId",
                "from.name",
                "from.address",
            ],
            Self::Event => &[
                "end",
                "location",
                "isAllDay",
                "isCancelled",
                "organizer.name",
                "organizer.address",
            ],
            Self::Task => &[
                "project.name",
                "stage.name",
                "partner.name",
                "priority",
                "state",
            ],
            Self::TimeEntry => &["hours", "project.name", "task.name"],
            Self::Invoice => &[
                "partner.name",
                "dueDate",
                "amountTotal",
                "currency.name",
                "paymentState",
                "state",
                "overdue",
            ],
            Self::Project => &["partner.name", "manager.name", "dateStart", "dateEnd"],
            Self::Partner => &["email", "phone", "isCompany", "parent.name"],
        }
    }
}

const COLUMN_FIELDS: &[(&str, &str)] = &[
    ("title", "title"),
    ("bodyText", "body_text"),
    ("occurredAt", "occurred_at"),
    ("updatedAt", "updated_at"),
    ("externalId", "external_id"),
];
const DATE_FIELDS: &[&str] = &[
    "occurredAt",
    "updatedAt",
    "data.end",
    "data.dueDate",
    "data.dateStart",
    "data.dateEnd",
];
const NUMERIC_FIELDS: &[&str] = &["data.hours", "data.amountTotal"];
const DATA_PREFIX: &str = "data.";

pub struct DayContext {
    today: String,
    day_starts: HashMap<i64, String>,
}

impl DayContext {
    pub fn from_config(config: &Value, today: &str) -> Self {
        let day_starts = config
            .get("dayStarts")
            .and_then(Value::as_object)
            .map(|starts| {
                starts
                    .iter()
                    .filter_map(|(offset, instant)| {
                        Some((offset.parse().ok()?, instant.as_str()?.to_owned()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            today: today.to_owned(),
            day_starts,
        }
    }

    fn day(&self, offset: i64) -> String {
        shift_day(&self.today, offset)
    }

    fn day_start(&self, offset: i64) -> String {
        self.day_starts
            .get(&offset)
            .cloned()
            .unwrap_or_else(|| format!("{}T00:00:00.000Z", self.day(offset)))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Neq,
    Gt,
    Lt,
    Contains,
    WithinDays,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct CustomFilter {
    pub field: String,
    pub op: FilterOp,
    pub value: FilterValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AggregateFn {
    Count,
    Sum,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CustomAggregate {
    #[serde(rename = "fn")]
    pub function: AggregateFn,
    pub field: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomWidgetSpec {
    pub item_kind: CustomItemKind,
    pub filters: Vec<CustomFilter>,
    pub group_by: Option<String>,
    pub aggregate: CustomAggregate,
    #[serde(default = "default_limit")]
    pub limit: u32,
}

fn default_limit() -> u32 {
    DEFAULT_LIMIT
}

fn field_expression(kind: CustomItemKind, field: &str) -> Result<String, CustomQueryError> {
    if let Some((_, column)) = COLUMN_FIELDS.iter().find(|(name, _)| *name == field) {
        return Ok((*column).to_owned());
    }
    if let Some(path) = field.strip_prefix(DATA_PREFIX) {
        if let Some(known) = kind.data_fields().iter().find(|known| **known == path) {
            return Ok(format!("json_extract(data_json, '$.{known}')"));
        }
    }
    Err(CustomQueryError::UnknownField(field.to_owned()))
}

fn escape_like(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn to_sql(value: &FilterValue) -> SqlValue {
    match value {
        FilterValue::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        FilterValue::Number(number) => SqlValue::Real(*number),
        FilterValue::Text(text) => SqlValue::Text(text.clone()),
    }
}

fn filter_clause(
    kind: CustomItemKind,
    filter: &CustomFilter,
    days: &DayContext,
    params: &mut Vec<SqlValue>,
) -> Result<String, CustomQueryError> {
    let expression = field_expression(kind, &filter.field)?;
    let clause = match filter.op {
        FilterOp::Eq | FilterOp::Neq | FilterOp::Gt | FilterOp::Lt => {
            let operator = match filter.op {
                FilterOp::Eq => "IS",
                FilterOp::Neq => "IS NOT",
                FilterOp::Gt => ">",
                _ => "<",
            };
            params.push(to_sql(&filter.value));
            format!("{expression} {operator} ?")
        }
        FilterOp::Contains => {
            let text = match &filter.value {
                FilterValue::Text(text) => text.clone(),
                FilterValue::Number(number) => number.to_string(),
                FilterValue::Bool(_) => {
                    return Err(CustomQueryError::InvalidFilter(
                        "contains needs a text value".to_owned(),
                    ))
                }
            };
            params.push(SqlValue::Text(format!("%{}%", escape_like(&text))));
            format!("{expression} LIKE ? ESCAPE '\\'")
        }
        FilterOp::WithinDays => {
            if !DATE_FIELDS.contains(&filter.field.as_str()) {
                return Err(CustomQueryError::InvalidFilter(format!(
                    "{} is not a date field",
                    filter.field
                )));
            }
            let FilterValue::Number(count) = filter.value else {
                return Err(CustomQueryError::InvalidFilter(
                    "within_days needs a number of days".to_owned(),
                ));
            };
            let span = days_span(count)?;
            let (from, to) = if span >= 0 { (0, span) } else { (span, 0) };
            params.push(SqlValue::Text(days.day(from)));
            params.push(SqlValue::Text(days.day(to)));
            params.push(SqlValue::Text(days.day_start(from)));
            params.push(SqlValue::Text(days.day_start(to + 1)));
            format!(
                "(CASE WHEN length({expression}) = {CALENDAR_DATE_LENGTH}                  THEN {expression} >= ? AND {expression} <= ?                  ELSE {expression} >= ? AND {expression} < ? END)"
            )
        }
    };
    Ok(clause)
}

fn days_span(count: f64) -> Result<i64, CustomQueryError> {
    if !count.is_finite() || count.abs() > MAX_WITHIN_DAYS as f64 {
        return Err(CustomQueryError::InvalidFilter(format!(
            "within_days must be between -{MAX_WITHIN_DAYS} and {MAX_WITHIN_DAYS}"
        )));
    }
    Ok(count.trunc() as i64)
}

fn aggregate_expression(
    kind: CustomItemKind,
    aggregate: &CustomAggregate,
) -> Result<String, CustomQueryError> {
    match aggregate.function {
        AggregateFn::Count => Ok("COUNT(*)".to_owned()),
        AggregateFn::Sum => {
            let field = aggregate
                .field
                .as_deref()
                .ok_or(CustomQueryError::InvalidAggregate)?;
            let expression = field_expression(kind, field)?;
            if !NUMERIC_FIELDS.contains(&field) {
                return Err(CustomQueryError::InvalidAggregate);
            }
            Ok(format!("COALESCE(SUM(CAST({expression} AS REAL)), 0.0)"))
        }
    }
}

pub fn build_query(
    spec: &CustomWidgetSpec,
    days: &DayContext,
) -> Result<(String, Vec<SqlValue>), CustomQueryError> {
    if spec.filters.len() > MAX_FILTERS {
        return Err(CustomQueryError::TooManyFilters);
    }
    let kind = spec.item_kind;
    let aggregate = aggregate_expression(kind, &spec.aggregate)?;
    let mut params = vec![SqlValue::Text(kind.column_value().to_owned())];
    let mut conditions = vec!["kind = ?".to_owned()];
    for filter in &spec.filters {
        conditions.push(filter_clause(kind, filter, days, &mut params)?);
    }
    let where_clause = conditions.join(" AND ");
    let sql = match spec.group_by.as_deref() {
        Some(group_field) => {
            let group = field_expression(kind, group_field)?;
            params.push(SqlValue::Integer(i64::from(
                spec.limit.clamp(MIN_LIMIT, MAX_LIMIT),
            )));
            format!(
                "SELECT COALESCE(CAST({group} AS TEXT), '{MISSING_LABEL}') AS label, {aggregate} AS value \
                 FROM items WHERE {where_clause} GROUP BY {group} ORDER BY value DESC, label ASC LIMIT ?"
            )
        }
        None => format!(
            "SELECT '{UNGROUPED_LABEL}' AS label, {aggregate} AS value FROM items WHERE {where_clause}"
        ),
    };
    Ok((sql, params))
}

pub fn run_custom_query(
    conn: &Connection,
    config: &Value,
    today: &str,
) -> Result<Value, CustomQueryError> {
    let spec: CustomWidgetSpec = serde_json::from_value(config.clone())
        .map_err(|error| CustomQueryError::InvalidSpec(error.to_string()))?;
    let (sql, params) = build_query(&spec, &DayContext::from_config(config, today))?;
    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let total: f64 = rows.iter().map(|row| row.1).sum();
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|(label, value)| json!({ "label": label, "value": value }))
        .collect();
    Ok(json!({ "rows": rows, "total": total }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::testing::{sample_connector, test_db};
    use crate::db::repo::{upsert, upsert_items};
    use regis_model::{ItemKind, ItemUpsert};

    fn time_entry(external_id: &str, project: &str, hours: f64) -> ItemUpsert {
        ItemUpsert {
            connector_id: "c1".to_owned(),
            kind: ItemKind::TimeEntry,
            external_id: external_id.to_owned(),
            title: external_id.to_owned(),
            body_text: None,
            occurred_at: Some("2026-10-20".to_owned()),
            data_json: json!({ "hours": hours, "project": { "id": 1, "name": project } }),
            updated_at: "2026-10-20T00:00:00.000Z".to_owned(),
        }
    }

    const TODAY: &str = "2026-10-22";
    const ZURICH_MIDNIGHT: &str = "2026-10-21T22:00:00.000Z";
    const ZURICH_NEXT_MIDNIGHT: &str = "2026-10-22T22:00:00.000Z";

    fn day_context() -> DayContext {
        DayContext::from_config(&json!({}), TODAY)
    }

    fn entry_at(external_id: &str, occurred_at: &str) -> ItemUpsert {
        ItemUpsert {
            occurred_at: Some(occurred_at.to_owned()),
            ..time_entry(external_id, "HMI", 1.0)
        }
    }

    fn zurich_count(conn: &Connection, days: i64) -> f64 {
        let data = run_custom_query(
            conn,
            &json!({
                "itemKind": "time_entry",
                "filters": [{ "field": "occurredAt", "op": "within_days", "value": days }],
                "aggregate": { "fn": "count" },
                "today": TODAY,
                "dayStarts": {
                    "-1": "2026-10-20T22:00:00.000Z",
                    "0": ZURICH_MIDNIGHT,
                    "1": ZURICH_NEXT_MIDNIGHT,
                },
            }),
            TODAY,
        )
        .expect("query");
        data["total"].as_f64().expect("total")
    }

    fn spec(value: Value) -> CustomWidgetSpec {
        serde_json::from_value(value).expect("spec")
    }

    fn hours_spec(filters: Value) -> CustomWidgetSpec {
        spec(json!({
            "itemKind": "time_entry",
            "filters": filters,
            "groupBy": "data.project.name",
            "aggregate": { "fn": "sum", "field": "data.hours" },
        }))
    }

    fn seeded(name: &str) -> crate::db::Db {
        let db = test_db(name);
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(
                conn,
                &[
                    time_entry("t1", "HMI", 2.5),
                    time_entry("t2", "HMI", 1.0),
                    time_entry("t3", "Atelier", 4.0),
                ],
            )?;
            Ok(())
        })
        .expect("seed");
        db
    }

    #[test]
    fn sum_hours_by_project_matches_manual_total() {
        let db = seeded("custom-query-sum");
        db.with_conn(|conn| {
            let data = run_custom_query(
                conn,
                &json!({
                    "title": "Heures", "itemKind": "time_entry", "filters": [],
                    "groupBy": "data.project.name",
                    "aggregate": { "fn": "sum", "field": "data.hours" }, "render": "bar",
                }),
                TODAY,
            )
            .expect("query");
            assert_eq!(
                data,
                json!({
                    "rows": [
                        { "label": "Atelier", "value": 4.0 },
                        { "label": "HMI", "value": 3.5 },
                    ],
                    "total": 7.5,
                })
            );
            Ok(())
        })
        .expect("db");
    }

    #[test]
    fn unknown_field_is_rejected_without_running() {
        let injected = "id; DROP TABLE items";
        let grouped = spec(json!({
            "itemKind": "time_entry", "filters": [],
            "groupBy": injected, "aggregate": { "fn": "count" },
        }));
        assert!(matches!(
            build_query(&grouped, &day_context()),
            Err(CustomQueryError::UnknownField(field)) if field == injected
        ));
        let filtered = hours_spec(json!([{ "field": injected, "op": "eq", "value": "a" }]));
        assert!(matches!(
            build_query(&filtered, &day_context()),
            Err(CustomQueryError::UnknownField(_))
        ));
        let summed = spec(json!({
            "itemKind": "time_entry", "filters": [],
            "aggregate": { "fn": "sum", "field": injected },
        }));
        assert!(matches!(
            build_query(&summed, &day_context()),
            Err(CustomQueryError::UnknownField(_))
        ));
        let db = seeded("custom-query-unknown");
        db.with_conn(|conn| {
            let result = run_custom_query(
                conn,
                &json!({
                    "itemKind": "task", "filters": [],
                    "groupBy": injected, "aggregate": { "fn": "count" },
                }),
                TODAY,
            );
            assert!(matches!(result, Err(CustomQueryError::UnknownField(_))));
            let remaining: i64 =
                conn.query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))?;
            assert_eq!(remaining, 3);
            Ok(())
        })
        .expect("db");
    }

    #[test]
    fn field_of_another_kind_is_unknown() {
        let wrong = spec(json!({
            "itemKind": "task", "filters": [],
            "groupBy": "data.hours", "aggregate": { "fn": "count" },
        }));
        assert!(matches!(
            build_query(&wrong, &day_context()),
            Err(CustomQueryError::UnknownField(_))
        ));
    }

    #[test]
    fn sum_requires_numeric_field() {
        let missing = spec(json!({
            "itemKind": "time_entry", "filters": [], "aggregate": { "fn": "sum" },
        }));
        assert!(matches!(
            build_query(&missing, &day_context()),
            Err(CustomQueryError::InvalidAggregate)
        ));
        let textual = spec(json!({
            "itemKind": "time_entry", "filters": [],
            "aggregate": { "fn": "sum", "field": "title" },
        }));
        assert!(matches!(
            build_query(&textual, &day_context()),
            Err(CustomQueryError::InvalidAggregate)
        ));
    }

    #[test]
    fn filter_values_only_travel_as_parameters() {
        let marker = "zz-marker'; --";
        let built = hours_spec(json!([
            { "field": "title", "op": "contains", "value": marker },
            { "field": "data.project.name", "op": "neq", "value": "Secret" },
            { "field": "data.hours", "op": "gt", "value": 7.25 },
            { "field": "occurredAt", "op": "within_days", "value": 14 },
        ]));
        let (sql, params) = build_query(&built, &day_context()).expect("query");
        for leaked in ["zz-marker", "Secret", "7.25", "14", "--"] {
            assert!(!sql.contains(leaked), "{leaked} leaked into {sql}");
        }
        assert!(params.contains(&SqlValue::Text(format!("%{marker}%"))));
        assert!(params.contains(&SqlValue::Text("Secret".to_owned())));
        assert!(params.contains(&SqlValue::Real(7.25)));
        assert!(params.contains(&SqlValue::Text("2026-10-22".to_owned())));
        assert!(params.contains(&SqlValue::Text("2026-11-05".to_owned())));
        assert!(params.contains(&SqlValue::Text("2026-10-22T00:00:00.000Z".to_owned())));
        assert!(params.contains(&SqlValue::Text("2026-11-06T00:00:00.000Z".to_owned())));
        assert_eq!(sql.matches('?').count(), params.len());
    }

    #[test]
    fn filters_narrow_the_result() {
        let db = seeded("custom-query-filters");
        db.with_conn(|conn| {
            let data = run_custom_query(
                conn,
                &json!({
                    "itemKind": "time_entry",
                    "filters": [{ "field": "data.hours", "op": "gt", "value": 1.5 }],
                    "aggregate": { "fn": "count" },
                }),
                TODAY,
            )
            .expect("query");
            assert_eq!(
                data,
                json!({ "rows": [{ "label": "Total", "value": 2.0 }], "total": 2.0 })
            );
            Ok(())
        })
        .expect("db");
    }

    #[test]
    fn within_days_uses_local_midnight_not_utc() {
        let db = test_db("custom-query-local-midnight");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(
                conn,
                &[
                    entry_at("before", "2026-10-21T21:59:59.000Z"),
                    entry_at("start", ZURICH_MIDNIGHT),
                    entry_at("late", "2026-10-22T21:59:59.999Z"),
                    entry_at("after", ZURICH_NEXT_MIDNIGHT),
                    entry_at("date-only", "2026-10-22"),
                ],
            )?;
            assert_eq!(zurich_count(conn, 0), 3.0);
            assert_eq!(zurich_count(conn, -1), 4.0);
            Ok(())
        })
        .expect("db");
    }

    #[test]
    fn within_days_without_day_starts_falls_back_to_utc_days() {
        let db = test_db("custom-query-utc-fallback");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(
                conn,
                &[
                    entry_at("in", "2026-10-22T00:00:00.000Z"),
                    entry_at("out", "2026-10-21T23:59:59.000Z"),
                ],
            )?;
            let data = run_custom_query(
                conn,
                &json!({
                    "itemKind": "time_entry",
                    "filters": [{ "field": "occurredAt", "op": "within_days", "value": 0 }],
                    "aggregate": { "fn": "count" },
                }),
                TODAY,
            )
            .expect("query");
            assert_eq!(data["total"], 1.0);
            Ok(())
        })
        .expect("db");
    }

    #[test]
    fn within_days_rejects_out_of_range_counts() {
        let built = hours_spec(json!([
            { "field": "occurredAt", "op": "within_days", "value": 100000 },
        ]));
        assert!(matches!(
            build_query(&built, &day_context()),
            Err(CustomQueryError::InvalidFilter(_))
        ));
    }
}
