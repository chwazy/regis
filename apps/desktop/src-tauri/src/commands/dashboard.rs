use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::State;

use crate::AppState;
use regis_core::db::repo::{self, ItemFilter, RepoError};
use regis_core::events::now_iso_utc;
use regis_core::widgets::custom_query::{run_custom_query, CustomQueryError};
use regis_core::widgets::{civil_from_days, format_day, parse_day, shift_day, DAY_LENGTH};
use regis_model::{Dashboard, Item, ItemKind, Widget};

const ITEM_SCAN_LIMIT: i64 = 2000;
const LIST_LIMIT: usize = 8;
const AGENDA_DAYS: i64 = 7;
const AWAITING_REPLY_DAYS: i64 = 7;
const UNREAD_WINDOW_DAYS: i64 = 30;
const DEFAULT_QUIET_DAYS: i64 = 30;
const DEFAULT_ENTITY_KIND: &str = "client";
const UNKNOWN_PROJECT: &str = "Sans projet";
const MONTH_LENGTH: usize = 7;
const DAYS_PER_WEEK: i64 = 7;
const ACTIVE_JOB_STATUSES: &str = "('queued', 'running', 'waiting_approval')";
const CLOSED_TASK_STATES: &[&str] = &["1_done", "1_canceled", "done", "cancel", "canceled"];

#[derive(Debug, thiserror::Error)]
pub enum WidgetDataError {
    #[error(transparent)]
    Repo(#[from] RepoError),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0} is not a widget computed from the local cache")]
    UnknownKind(String),
    #[error(transparent)]
    Custom(#[from] CustomQueryError),
}

fn describe(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn week_start(day: &str) -> String {
    parse_day(day).map_or_else(
        || day.to_owned(),
        |days| format_day(days - (days + 3).rem_euclid(DAYS_PER_WEEK)),
    )
}

fn shift_instant(instant: &str, delta_days: i64) -> String {
    let day = shift_day(instant, delta_days);
    format!("{day}{}", instant.get(DAY_LENGTH..).unwrap_or_default())
}

fn day_of(value: &str) -> &str {
    value.get(..DAY_LENGTH).unwrap_or(value)
}

struct DayWindows {
    day_start: String,
    day_end: String,
    agenda_end: String,
    month_start: String,
    month_end: String,
}

fn midnight_utc(day: &str) -> String {
    format!("{day}T00:00:00.000Z")
}

fn next_month_start(day: &str) -> String {
    let (year, month, _) = parse_day(day).map_or((1970, 1, 1), civil_from_days);
    let (year, month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    format!("{year:04}-{month:02}-01")
}

impl DayWindows {
    fn utc_days(today: &str) -> Self {
        let month = today.get(..MONTH_LENGTH).unwrap_or(today);
        Self {
            day_start: midnight_utc(today),
            day_end: midnight_utc(&shift_day(today, 1)),
            agenda_end: midnight_utc(&shift_day(today, AGENDA_DAYS)),
            month_start: midnight_utc(&format!("{month}-01")),
            month_end: midnight_utc(&next_month_start(today)),
        }
    }

    fn from_config(config: &Value, today: &str) -> Self {
        let bound = |key: &str| {
            config
                .pointer(&format!("/windows/{key}"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let fallback = Self::utc_days(today);
        Self {
            day_start: bound("dayStart").unwrap_or(fallback.day_start),
            day_end: bound("dayEnd").unwrap_or(fallback.day_end),
            agenda_end: bound("agendaEnd").unwrap_or(fallback.agenda_end),
            month_start: bound("monthStart").unwrap_or(fallback.month_start),
            month_end: bound("monthEnd").unwrap_or(fallback.month_end),
        }
    }
}

fn text_at<'a>(data: &'a Value, pointer: &str) -> Option<&'a str> {
    data.pointer(pointer).and_then(Value::as_str)
}

fn flag_at(data: &Value, pointer: &str) -> bool {
    data.pointer(pointer).and_then(Value::as_bool) == Some(true)
}

fn items_of(conn: &Connection, kind: ItemKind) -> Result<Vec<Item>, RepoError> {
    repo::list_items(
        conn,
        &ItemFilter {
            kind: Some(kind),
            limit: Some(ITEM_SCAN_LIMIT),
            ..ItemFilter::default()
        },
    )
}

fn inbox(conn: &Connection, now: &str) -> Result<Value, WidgetDataError> {
    let messages = items_of(conn, ItemKind::Message)?;
    let unread_since = shift_instant(now, -UNREAD_WINDOW_DAYS);
    let reply_since = shift_instant(now, -AWAITING_REPLY_DAYS);
    let received = |message: &Item| {
        message
            .occurred_at
            .as_deref()
            .unwrap_or_default()
            .to_owned()
    };

    let unread: Vec<&Item> = messages
        .iter()
        .filter(|message| {
            !flag_at(&message.data_json, "/isRead") && received(message) >= unread_since
        })
        .collect();
    let priority = unread
        .iter()
        .filter(|message| text_at(&message.data_json, "/importance") == Some("high"))
        .count();

    let mut latest_by_conversation: HashMap<String, &Item> = HashMap::new();
    for message in &messages {
        let key = text_at(&message.data_json, "/conversationId")
            .map_or_else(|| message.id.clone(), str::to_owned);
        let is_newer = latest_by_conversation
            .get(&key)
            .is_none_or(|known| received(known) < received(message));
        if is_newer {
            latest_by_conversation.insert(key, message);
        }
    }
    let awaiting_reply = latest_by_conversation
        .values()
        .filter(|message| {
            flag_at(&message.data_json, "/isRead") && received(message) >= reply_since
        })
        .count();

    Ok(json!({ "unread": unread.len(), "priority": priority, "awaitingReply": awaiting_reply }))
}

fn project_name(entry: &Item) -> String {
    text_at(&entry.data_json, "/project/name")
        .filter(|name| !name.is_empty())
        .unwrap_or(UNKNOWN_PROJECT)
        .to_owned()
}

fn hours_by_project(conn: &Connection, today: &str) -> Result<Value, WidgetDataError> {
    let start = week_start(today);
    let end = shift_day(&start, DAYS_PER_WEEK - 1);
    let mut per_project: HashMap<String, f64> = HashMap::new();
    for entry in items_of(conn, ItemKind::TimeEntry)? {
        let Some(occurred_at) = entry.occurred_at.as_deref() else {
            continue;
        };
        let day = day_of(occurred_at);
        if day < start.as_str() || day > end.as_str() {
            continue;
        }
        let hours = entry
            .data_json
            .get("hours")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        *per_project.entry(project_name(&entry)).or_insert(0.0) += hours;
    }
    let mut rows: Vec<(String, f64)> = per_project.into_iter().collect();
    rows.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    let total: f64 = rows.iter().map(|row| row.1).sum();
    let projects: Vec<Value> = rows
        .into_iter()
        .map(|(name, hours)| json!({ "projectName": name, "hours": hours }))
        .collect();
    Ok(json!({ "weekStart": start, "total": total, "projects": projects }))
}

fn week_agenda(conn: &Connection, windows: &DayWindows) -> Result<Value, WidgetDataError> {
    let mut events: Vec<Item> = items_of(conn, ItemKind::Event)?
        .into_iter()
        .filter(|event| {
            let at = event.occurred_at.as_deref().unwrap_or_default();
            at >= windows.day_start.as_str()
                && at < windows.agenda_end.as_str()
                && !flag_at(&event.data_json, "/isCancelled")
        })
        .collect();
    events.sort_by(|left, right| left.occurred_at.cmp(&right.occurred_at));
    let count = events.len();
    let listed: Vec<Value> = events
        .into_iter()
        .take(LIST_LIMIT)
        .map(|event| {
            json!({
                "id": event.id,
                "title": event.title,
                "startsAt": event.occurred_at,
                "location": text_at(&event.data_json, "/location"),
            })
        })
        .collect();
    Ok(json!({ "count": count, "events": listed }))
}

fn is_open_task(task: &Item) -> bool {
    text_at(&task.data_json, "/state").is_none_or(|state| !CLOSED_TASK_STATES.contains(&state))
}

fn odoo_tasks(conn: &Connection) -> Result<Value, WidgetDataError> {
    let mut open: Vec<Item> = items_of(conn, ItemKind::Task)?
        .into_iter()
        .filter(is_open_task)
        .collect();
    open.sort_by(
        |left, right| match (&left.occurred_at, &right.occurred_at) {
            (Some(a), Some(b)) => a.cmp(b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        },
    );
    let count = open.len();
    let listed: Vec<Value> = open
        .into_iter()
        .take(LIST_LIMIT)
        .map(|task| json!({ "id": task.id, "title": task.title, "dueDate": task.occurred_at.as_deref().map(day_of) }))
        .collect();
    Ok(json!({ "count": count, "tasks": listed }))
}

fn invoices(conn: &Connection, windows: &DayWindows) -> Result<Value, WidgetDataError> {
    let (mut overdue, mut to_issue, mut paid_this_month) = (0_usize, 0_usize, 0_usize);
    let mut outstanding = 0.0_f64;
    let mut currency: Option<String> = None;
    for invoice in items_of(conn, ItemKind::Invoice)? {
        let data = &invoice.data_json;
        let state = text_at(data, "/state");
        let paid = text_at(data, "/paymentState") == Some("paid");
        if flag_at(data, "/overdue") {
            overdue += 1;
        }
        if state == Some("draft") {
            to_issue += 1;
        }
        let touched = invoice.updated_at.as_str();
        if paid && touched >= windows.month_start.as_str() && touched < windows.month_end.as_str() {
            paid_this_month += 1;
        }
        if state == Some("posted") && !paid {
            outstanding += data
                .get("amountTotal")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            currency = currency.or_else(|| text_at(data, "/currency/name").map(str::to_owned));
        }
    }
    Ok(json!({
        "overdue": overdue,
        "toIssue": to_issue,
        "paidThisMonth": paid_this_month,
        "outstandingAmount": outstanding,
        "currency": currency,
    }))
}

fn jobs(conn: &Connection, windows: &DayWindows) -> Result<Value, WidgetDataError> {
    let mut statement = conn.prepare(&format!(
        "SELECT id, title, status FROM jobs WHERE status IN {ACTIVE_JOB_STATUSES} ORDER BY created_at DESC"
    ))?;
    let active: Vec<Value> = statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>("id")?,
                "title": row.get::<_, String>("title")?,
                "status": row.get::<_, String>("status")?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let cost_today: f64 = conn.query_row(
        "SELECT COALESCE(SUM(cost_usd), 0) FROM jobs WHERE created_at >= ?1 AND created_at < ?2",
        [&windows.day_start, &windows.day_end],
        |row| row.get(0),
    )?;
    let count = active.len();
    let listed: Vec<Value> = active.into_iter().take(LIST_LIMIT).collect();
    Ok(json!({ "activeCount": count, "active": listed, "costTodayUsd": cost_today }))
}

fn recent_files(conn: &Connection) -> Result<Value, WidgetDataError> {
    let mut statement =
        conn.prepare("SELECT id, rel_path, role, mtime FROM files ORDER BY mtime DESC LIMIT ?1")?;
    let files: Vec<Value> = statement
        .query_map([LIST_LIMIT as i64], |row| {
            Ok(json!({
                "id": row.get::<_, String>("id")?,
                "relPath": row.get::<_, String>("rel_path")?,
                "role": row.get::<_, String>("role")?,
                "modifiedAt": row.get::<_, String>("mtime")?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(json!({ "files": files }))
}

fn entity_query(conn: &Connection, config: &Value, today: &str) -> Result<Value, WidgetDataError> {
    let days = config
        .get("days")
        .and_then(Value::as_i64)
        .filter(|days| *days > 0)
        .unwrap_or(DEFAULT_QUIET_DAYS);
    let kind = config
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_ENTITY_KIND);
    let limit = shift_day(today, -days);
    let mut statement = conn.prepare(
        "SELECT e.id, e.name, MAX(i.occurred_at) AS last_contact FROM entities e
         LEFT JOIN links l ON l.to_type = 'entity' AND l.to_id = e.id AND l.from_type = 'item'
         LEFT JOIN items i ON i.id = l.from_id AND i.kind IN ('message', 'event')
         WHERE e.kind = ?1 GROUP BY e.id ORDER BY last_contact IS NOT NULL, last_contact, e.name",
    )?;
    let quiet: Vec<(String, String, Option<String>)> = statement
        .query_map([kind], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let quiet: Vec<Value> = quiet
        .into_iter()
        .filter(|(_, _, last)| {
            last.as_deref()
                .is_none_or(|last| day_of(last) < limit.as_str())
        })
        .map(|(id, name, last)| json!({ "id": id, "name": name, "lastContact": last }))
        .collect();
    let count = quiet.len();
    let listed: Vec<Value> = quiet.into_iter().take(LIST_LIMIT).collect();
    Ok(json!({ "days": days, "count": count, "entities": listed }))
}

pub fn widget_data_at(
    conn: &Connection,
    kind: &str,
    config: &Value,
    now: &str,
) -> Result<Value, WidgetDataError> {
    let today = config
        .get("today")
        .and_then(Value::as_str)
        .filter(|today| parse_day(today).is_some())
        .map_or_else(|| day_of(now).to_owned(), str::to_owned);
    let windows = DayWindows::from_config(config, &today);
    match kind {
        "inbox" => inbox(conn, now),
        "hours_by_project" => hours_by_project(conn, &today),
        "week_agenda" => week_agenda(conn, &windows),
        "odoo_tasks" => odoo_tasks(conn),
        "invoices" => invoices(conn, &windows),
        "jobs" => jobs(conn, &windows),
        "recent_files" => recent_files(conn),
        "entity_query" => entity_query(conn, config, &today),
        "custom" => Ok(run_custom_query(conn, config, &today)?),
        other => Err(WidgetDataError::UnknownKind(other.to_owned())),
    }
}

#[tauri::command]
pub async fn list_dashboards(state: State<'_, AppState>) -> Result<Vec<Dashboard>, String> {
    state
        .db
        .with_conn(|conn| repo::list_dashboards(conn))
        .map_err(describe)
}

#[tauri::command]
pub async fn save_dashboard(
    state: State<'_, AppState>,
    dashboard: Dashboard,
) -> Result<Dashboard, String> {
    state
        .db
        .with_conn(|conn| repo::save_dashboard(conn, dashboard))
        .map_err(describe)
}

#[tauri::command]
pub async fn delete_dashboard(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .db
        .with_conn(|conn| repo::delete::<Dashboard>(conn, &id))
        .map(|_| ())
        .map_err(describe)
}

#[tauri::command]
pub async fn list_widgets(
    state: State<'_, AppState>,
    dashboard_id: String,
) -> Result<Vec<Widget>, String> {
    state
        .db
        .with_conn(|conn| repo::list_widgets(conn, &dashboard_id))
        .map_err(describe)
}

#[tauri::command]
pub async fn save_widgets(
    state: State<'_, AppState>,
    dashboard_id: String,
    widgets: Vec<Widget>,
) -> Result<Vec<Widget>, String> {
    state
        .db
        .with_conn(|conn| repo::save_widgets(conn, &dashboard_id, widgets))
        .map_err(describe)
}

#[tauri::command]
pub async fn delete_widget(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .db
        .with_conn(|conn| repo::delete::<Widget>(conn, &id))
        .map(|_| ())
        .map_err(describe)
}

#[tauri::command]
pub async fn widget_data(
    state: State<'_, AppState>,
    kind: String,
    config: Option<Value>,
) -> Result<Value, String> {
    let config = config.unwrap_or_else(|| json!({}));
    let now = now_iso_utc();
    state
        .db
        .with_conn(|conn| {
            widget_data_at(conn, &kind, &config, &now)
                .map_err(|error| RepoError::Invalid(error.to_string()))
        })
        .map_err(describe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use regis_core::db::repo::testing::{sample_connector, test_db};
    use regis_core::db::repo::{upsert, upsert_items};
    use regis_model::ItemUpsert;

    const NOW: &str = "2026-10-22T09:00:00.000Z";

    fn item(kind: ItemKind, external_id: &str, occurred_at: &str, data: Value) -> ItemUpsert {
        ItemUpsert {
            connector_id: "c1".to_owned(),
            kind,
            external_id: external_id.to_owned(),
            title: external_id.to_owned(),
            body_text: None,
            occurred_at: Some(occurred_at.to_owned()),
            data_json: data,
            updated_at: occurred_at.to_owned(),
        }
    }

    fn entry(external_id: &str, day: &str, project: Option<&str>, hours: f64) -> ItemUpsert {
        let project = project.map_or(Value::Null, |name| json!({ "id": 1, "name": name }));
        item(
            ItemKind::TimeEntry,
            external_id,
            day,
            json!({ "hours": hours, "project": project }),
        )
    }

    #[test]
    fn widget_data_hours() {
        let db = test_db("widget-hours");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(
                conn,
                &[
                    entry("t1", "2026-10-19", Some("HMI"), 2.5),
                    entry("t2", "2026-10-22", Some("HMI"), 1.0),
                    entry("t3", "2026-10-25", Some("Atelier"), 4.0),
                    entry("t4", "2026-10-21", None, 0.5),
                    entry("old", "2026-10-18", Some("HMI"), 8.0),
                    entry("next", "2026-10-26", Some("HMI"), 8.0),
                ],
            )?;
            let data =
                widget_data_at(conn, "hours_by_project", &json!({}), NOW).expect("widget data");
            assert_eq!(
                data,
                json!({
                    "weekStart": "2026-10-19",
                    "total": 8.0,
                    "projects": [
                        { "projectName": "Atelier", "hours": 4.0 },
                        { "projectName": "HMI", "hours": 3.5 },
                        { "projectName": "Sans projet", "hours": 0.5 },
                    ],
                })
            );
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn iso_week_starts_on_monday_across_month_and_year_ends() {
        assert_eq!(week_start("2026-10-25"), "2026-10-19");
        assert_eq!(week_start("2026-10-19"), "2026-10-19");
        assert_eq!(week_start("2027-01-01"), "2026-12-28");
        assert_eq!(shift_day("2026-02-27", 3), "2026-03-02");
        assert_eq!(shift_instant(NOW, -30), "2026-09-22T09:00:00.000Z");
    }

    #[test]
    fn inbox_counts_unread_priority_and_conversations_awaiting_a_reply() {
        let db = test_db("widget-inbox");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            let message = |id: &str, at: &str, read: bool, importance: &str, conversation: &str| {
                item(
                    ItemKind::Message,
                    id,
                    at,
                    json!({ "isRead": read, "importance": importance, "conversationId": conversation }),
                )
            };
            upsert_items(
                conn,
                &[
                    message("m1", "2026-10-22T07:00:00.000Z", false, "high", "a"),
                    message("m2", "2026-10-21T07:00:00.000Z", false, "normal", "b"),
                    message("m3", "2026-10-20T07:00:00.000Z", true, "normal", "c"),
                    message("m4", "2026-10-19T07:00:00.000Z", true, "normal", "c"),
                    message("m5", "2026-09-01T07:00:00.000Z", false, "high", "d"),
                ],
            )?;
            let data = widget_data_at(conn, "inbox", &json!({}), NOW).expect("widget data");
            assert_eq!(
                data,
                json!({ "unread": 2, "priority": 1, "awaitingReply": 1 })
            );
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn invoices_split_overdue_to_issue_and_paid_this_month() {
        let db = test_db("widget-invoices");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            let invoice = |id: &str, state: &str, payment: &str, overdue: bool, amount: f64| {
                item(
                    ItemKind::Invoice,
                    id,
                    "2026-10-05",
                    json!({
                        "state": state, "paymentState": payment, "overdue": overdue,
                        "amountTotal": amount, "currency": { "id": 1, "name": "CHF" },
                    }),
                )
            };
            upsert_items(
                conn,
                &[
                    invoice("i1", "posted", "not_paid", true, 1000.0),
                    invoice("i2", "draft", "not_paid", false, 500.0),
                    invoice("i3", "posted", "paid", false, 200.0),
                    invoice("i4", "posted", "not_paid", false, 300.0),
                ],
            )?;
            let data = widget_data_at(conn, "invoices", &json!({}), NOW).expect("widget data");
            assert_eq!(
                data,
                json!({
                    "overdue": 1, "toIssue": 1, "paidThisMonth": 1,
                    "outstandingAmount": 1300.0, "currency": "CHF",
                })
            );
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn week_agenda_keeps_the_next_seven_days_and_skips_cancelled_events() {
        let db = test_db("widget-agenda");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(
                conn,
                &[
                    item(
                        ItemKind::Event,
                        "today",
                        "2026-10-22T13:00:00.000Z",
                        json!({}),
                    ),
                    item(
                        ItemKind::Event,
                        "edge",
                        "2026-10-28T13:00:00.000Z",
                        json!({}),
                    ),
                    item(
                        ItemKind::Event,
                        "later",
                        "2026-10-29T13:00:00.000Z",
                        json!({}),
                    ),
                    item(
                        ItemKind::Event,
                        "past",
                        "2026-10-21T13:00:00.000Z",
                        json!({}),
                    ),
                    item(
                        ItemKind::Event,
                        "cancelled",
                        "2026-10-23T13:00:00.000Z",
                        json!({ "isCancelled": true }),
                    ),
                ],
            )?;
            let data = widget_data_at(conn, "week_agenda", &json!({}), NOW).expect("widget data");
            let ids: Vec<&str> = data["events"]
                .as_array()
                .expect("events")
                .iter()
                .filter_map(|event| event["title"].as_str())
                .collect();
            assert_eq!(ids, ["today", "edge"]);
            assert_eq!(data["count"], 2);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn entity_query_lists_entities_quiet_for_more_than_the_given_days() {
        let db = test_db("widget-entities");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(
                conn,
                &[
                    item(ItemKind::Message, "recent", "2026-10-15T08:00:00.000Z", json!({})),
                    item(ItemKind::Message, "stale", "2026-08-01T08:00:00.000Z", json!({})),
                ],
            )?;
            for (id, name) in [("e1", "Actif"), ("e2", "Dormant"), ("e3", "Jamais")] {
                conn.execute(
                    "INSERT INTO entities (id, kind, name, created_at, updated_at) VALUES (?1, 'client', ?2, ?3, ?3)",
                    rusqlite::params![id, name, NOW],
                )?;
            }
            for (item_external, entity) in [("recent", "e1"), ("stale", "e2")] {
                conn.execute(
                    "INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, created_at)
                     SELECT ?1, 'item', id, 'entity', ?2, 'about', 'user', ?3 FROM items WHERE external_id = ?4",
                    rusqlite::params![format!("l-{entity}"), entity, NOW, item_external],
                )?;
            }
            let data = widget_data_at(conn, "entity_query", &json!({ "days": 30 }), NOW)
                .expect("widget data");
            let names: Vec<&str> = data["entities"]
                .as_array()
                .expect("entities")
                .iter()
                .filter_map(|entity| entity["name"].as_str())
                .collect();
            assert_eq!(names, ["Jamais", "Dormant"]);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn tasks_jobs_and_files_summaries_come_from_the_cache() {
        let db = test_db("widget-misc");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(
                conn,
                &[
                    item(ItemKind::Task, "late", "2026-10-20", json!({ "state": "01_in_progress" })),
                    item(ItemKind::Task, "done", "2026-10-19", json!({ "state": "1_done" })),
                ],
            )?;
            conn.execute(
                "INSERT INTO agents (id, name, runtime, mode) VALUES ('a1', 'Agent', 'ollama', 'headless')",
                [],
            )?;
            for (id, status, cost) in [("j1", "running", 0.25), ("j2", "done", 0.5), ("j3", "queued", 0.0)] {
                conn.execute(
                    "INSERT INTO jobs (id, agent_id, title, prompt, status, cost_usd, created_at) VALUES (?1, 'a1', ?1, 'p', ?2, ?3, '2026-10-22T07:00:00.000Z')",
                    rusqlite::params![id, status, cost],
                )?;
            }
            conn.execute(
                "INSERT INTO file_sources (id, kind, path, watch_mode) VALUES ('s1', 'local', 'docs', 'poll')",
                [],
            )?;
            for (id, mtime) in [("f1", "2026-10-20T00:00:00.000Z"), ("f2", "2026-10-21T00:00:00.000Z")] {
                conn.execute(
                    "INSERT INTO files (id, source_id, rel_path, ext, size, mtime, role) VALUES (?1, 's1', ?1, 'pdf', 1, ?2, 'generated')",
                    rusqlite::params![id, mtime],
                )?;
            }

            let tasks = widget_data_at(conn, "odoo_tasks", &json!({}), NOW).expect("tasks");
            assert_eq!(tasks["count"], 1);
            let jobs = widget_data_at(conn, "jobs", &json!({}), NOW).expect("jobs");
            assert_eq!(jobs["activeCount"], 2);
            assert_eq!(jobs["costTodayUsd"], 0.75);
            let files = widget_data_at(conn, "recent_files", &json!({}), NOW).expect("files");
            assert_eq!(files["files"][0]["id"], "f2");
            Ok(())
        })
        .expect("repo calls");
    }

    fn zurich_windows(today: &str, day_start: &str, day_end: &str) -> Value {
        json!({
            "today": today,
            "windows": {
                "dayStart": day_start,
                "dayEnd": day_end,
                "agendaEnd": "2026-10-28T23:00:00.000Z",
                "monthStart": "2026-09-30T22:00:00.000Z",
                "monthEnd": "2026-10-31T23:00:00.000Z",
            },
        })
    }

    fn zurich_today() -> Value {
        zurich_windows(
            "2026-10-22",
            "2026-10-21T22:00:00.000Z",
            "2026-10-22T22:00:00.000Z",
        )
    }

    #[test]
    fn agenda_window_uses_local_day_bounds() {
        let db = test_db("widget-agenda-local");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            upsert_items(
                conn,
                &[
                    item(
                        ItemKind::Event,
                        "before",
                        "2026-10-21T21:30:00.000Z",
                        json!({}),
                    ),
                    item(
                        ItemKind::Event,
                        "local-0030",
                        "2026-10-21T22:30:00.000Z",
                        json!({}),
                    ),
                    item(
                        ItemKind::Event,
                        "last-evening",
                        "2026-10-28T22:30:00.000Z",
                        json!({}),
                    ),
                    item(
                        ItemKind::Event,
                        "after",
                        "2026-10-28T23:30:00.000Z",
                        json!({}),
                    ),
                ],
            )?;
            let data =
                widget_data_at(conn, "week_agenda", &zurich_today(), NOW).expect("widget data");
            let titles: Vec<&str> = data["events"]
                .as_array()
                .expect("events")
                .iter()
                .filter_map(|event| event["title"].as_str())
                .collect();
            assert_eq!(titles, ["local-0030", "last-evening"]);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn jobs_cost_of_the_day_uses_local_day_bounds() {
        let db = test_db("widget-jobs-local");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            conn.execute(
                "INSERT INTO agents (id, name, runtime, mode) VALUES ('a1', 'Agent', 'ollama', 'headless')",
                [],
            )?;
            for (id, created_at, cost) in [
                ("early", "2026-10-21T21:59:00.000Z", 1.0),
                ("local-0100", "2026-10-21T23:00:00.000Z", 0.5),
                ("evening", "2026-10-22T21:59:00.000Z", 0.25),
                ("next-day", "2026-10-22T22:00:00.000Z", 4.0),
            ] {
                conn.execute(
                    "INSERT INTO jobs (id, agent_id, title, prompt, status, cost_usd, created_at) VALUES (?1, 'a1', ?1, 'p', 'done', ?2, ?3)",
                    rusqlite::params![id, cost, created_at],
                )?;
            }
            let data = widget_data_at(conn, "jobs", &zurich_today(), NOW).expect("widget data");
            assert_eq!(data["costTodayUsd"], 0.75);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn paid_invoices_are_counted_in_the_local_month() {
        let db = test_db("widget-invoices-local");
        db.with_conn(|conn| {
            upsert(conn, &sample_connector("c1"))?;
            let paid = |id: &str, updated_at: &str| {
                let mut invoice = item(
                    ItemKind::Invoice,
                    id,
                    "2026-10-05",
                    json!({ "state": "posted", "paymentState": "paid" }),
                );
                invoice.updated_at = updated_at.to_owned();
                invoice
            };
            upsert_items(
                conn,
                &[
                    paid("september", "2026-09-30T21:30:00.000Z"),
                    paid("october-local", "2026-09-30T22:30:00.000Z"),
                    paid("october-end", "2026-10-31T22:30:00.000Z"),
                    paid("november", "2026-10-31T23:30:00.000Z"),
                ],
            )?;
            let data = widget_data_at(conn, "invoices", &zurich_today(), NOW).expect("widget data");
            assert_eq!(data["paidThisMonth"], 2);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn missing_windows_fall_back_to_utc_days_of_today() {
        let windows = DayWindows::utc_days("2026-12-31");
        assert_eq!(windows.day_start, "2026-12-31T00:00:00.000Z");
        assert_eq!(windows.agenda_end, "2027-01-07T00:00:00.000Z");
        assert_eq!(windows.month_start, "2026-12-01T00:00:00.000Z");
        assert_eq!(windows.month_end, "2027-01-01T00:00:00.000Z");
    }

    #[test]
    fn unknown_kinds_are_rejected() {
        let db = test_db("widget-unknown");
        db.with_conn(|conn| {
            assert!(widget_data_at(conn, "mcp_tool", &json!({}), NOW).is_err());
            Ok(())
        })
        .expect("repo calls");
    }
}
