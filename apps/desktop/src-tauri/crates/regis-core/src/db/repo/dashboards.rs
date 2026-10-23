use rusqlite::types::Value;
use rusqlite::{Connection, Row};
use serde_json::json;

use super::{column_json, json_text, list_where, new_id, text, upsert, Record, RepoError};
use regis_model::{Dashboard, Widget};

pub const GRID_COLUMNS: i64 = 12;

const DEFAULT_DASHBOARD_NAME: &str = "Travail";
const DEFAULT_WIDGETS: &[(&str, &str, i64, i64, i64, i64)] = &[
    ("inbox", "Boîtes de réception", 0, 0, 3, 4),
    ("hours_by_project", "Heures par projet", 3, 0, 3, 4),
    ("week_agenda", "Semaine", 6, 0, 6, 4),
    ("odoo_tasks", "Tâches Odoo", 0, 4, 3, 4),
    ("invoices", "Factures", 3, 4, 3, 4),
    ("jobs", "Jobs agents", 6, 4, 3, 4),
    ("recent_files", "Fichiers récents", 9, 4, 3, 4),
];

impl Record for Dashboard {
    const TABLE: &'static str = "dashboards";
    const COLUMNS: &'static [&'static str] = &["id", "name", "ord"];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Dashboard {
            id: row.get("id")?,
            name: row.get("name")?,
            ord: row.get("ord")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.name),
            Value::Integer(self.ord),
        ])
    }
}

impl Record for Widget {
    const TABLE: &'static str = "widgets";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "dashboard_id",
        "kind",
        "title",
        "config_json",
        "x",
        "y",
        "w",
        "h",
    ];

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Widget {
            id: row.get("id")?,
            dashboard_id: row.get("dashboard_id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
            config_json: column_json(row, "config_json")?,
            x: row.get("x")?,
            y: row.get("y")?,
            w: row.get("w")?,
            h: row.get("h")?,
        })
    }

    fn values(&self) -> Result<Vec<Value>, RepoError> {
        Ok(vec![
            text(&self.id),
            text(&self.dashboard_id),
            text(&self.kind),
            text(&self.title),
            json_text(&self.config_json),
            Value::Integer(self.x),
            Value::Integer(self.y),
            Value::Integer(self.w),
            Value::Integer(self.h),
        ])
    }
}

pub fn list_dashboards(conn: &Connection) -> Result<Vec<Dashboard>, RepoError> {
    list_where(conn, "1 = 1", "ord, rowid", Vec::new())
}

pub fn save_dashboard(conn: &Connection, mut dashboard: Dashboard) -> Result<Dashboard, RepoError> {
    dashboard.name = dashboard.name.trim().to_owned();
    if dashboard.name.is_empty() {
        return Err(RepoError::Invalid("a dashboard needs a name".to_owned()));
    }
    if dashboard.id.is_empty() {
        dashboard.id = new_id();
        dashboard.ord = conn.query_row(
            "SELECT COALESCE(MAX(ord), -1) + 1 FROM dashboards",
            [],
            |row| row.get(0),
        )?;
    }
    upsert(conn, &dashboard)?;
    Ok(dashboard)
}

pub fn list_widgets(conn: &Connection, dashboard_id: &str) -> Result<Vec<Widget>, RepoError> {
    list_where(
        conn,
        "dashboard_id = ?1",
        "y, x, rowid",
        vec![text(dashboard_id)],
    )
}

pub fn save_widgets(
    conn: &mut Connection,
    dashboard_id: &str,
    widgets: Vec<Widget>,
) -> Result<Vec<Widget>, RepoError> {
    for widget in &widgets {
        let fits = widget.x >= 0
            && widget.y >= 0
            && widget.w >= 1
            && widget.h >= 1
            && widget.x + widget.w <= GRID_COLUMNS;
        if !fits {
            return Err(RepoError::Invalid(format!(
                "widget {} does not fit the {GRID_COLUMNS}-column grid",
                widget.id
            )));
        }
    }
    let transaction = conn.transaction()?;
    for mut widget in widgets {
        if widget.id.is_empty() {
            widget.id = new_id();
        }
        widget.dashboard_id = dashboard_id.to_owned();
        upsert(&transaction, &widget)?;
    }
    transaction.commit()?;
    list_widgets(conn, dashboard_id)
}

pub fn seed_default_dashboard(conn: &Connection) -> Result<(), RepoError> {
    let dashboard = save_dashboard(
        conn,
        Dashboard {
            id: String::new(),
            name: DEFAULT_DASHBOARD_NAME.to_owned(),
            ord: 0,
        },
    )?;
    for (kind, title, x, y, w, h) in DEFAULT_WIDGETS {
        upsert(
            conn,
            &Widget {
                id: new_id(),
                dashboard_id: dashboard.id.clone(),
                kind: (*kind).to_owned(),
                title: (*title).to_owned(),
                config_json: json!({}),
                x: *x,
                y: *y,
                w: *w,
                h: *h,
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::delete;
    use crate::db::repo::testing::test_db;

    fn view(name: &str) -> Dashboard {
        Dashboard {
            id: String::new(),
            name: name.to_owned(),
            ord: 0,
        }
    }

    fn widget(x: i64, y: i64) -> Widget {
        Widget {
            id: String::new(),
            dashboard_id: String::new(),
            kind: "jobs".to_owned(),
            title: "Jobs".to_owned(),
            config_json: json!({}),
            x,
            y,
            w: 3,
            h: 2,
        }
    }

    #[test]
    fn views_can_be_created_renamed_and_deleted_with_their_widgets() {
        let db = test_db("dashboards-crud");
        db.with_conn(|conn| {
            let mut created = save_dashboard(conn, view("Perso"))?;
            created.name = "Maison".to_owned();
            save_dashboard(conn, created.clone())?;
            save_widgets(conn, &created.id, vec![widget(0, 0)])?;
            assert_eq!(list_dashboards(conn)?[0].name, "Maison");
            assert_eq!(list_widgets(conn, &created.id)?.len(), 1);

            assert!(delete::<Dashboard>(conn, &created.id)?);
            assert!(list_dashboards(conn)?.is_empty());
            let orphans: i64 =
                conn.query_row("SELECT COUNT(*) FROM widgets", [], |row| row.get(0))?;
            assert_eq!(orphans, 0);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn new_views_are_appended_after_existing_ones() {
        let db = test_db("dashboards-order");
        db.with_conn(|conn| {
            for name in ["A", "B", "C"] {
                save_dashboard(conn, view(name))?;
            }
            let names: Vec<String> = list_dashboards(conn)?
                .into_iter()
                .map(|listed| listed.name)
                .collect();
            assert_eq!(names, ["A", "B", "C"]);
            Ok(())
        })
        .expect("repo calls");
    }

    #[test]
    fn saving_widgets_persists_every_position_in_one_transaction() {
        let db = test_db("dashboards-widgets");
        db.with_conn(|conn| {
            let created = save_dashboard(conn, view("Travail"))?;
            let saved = save_widgets(conn, &created.id, vec![widget(0, 0), widget(3, 0)])?;
            let mut moved = saved.clone();
            moved[0].x = 6;
            moved[0].y = 2;
            moved[1].w = 5;
            let reloaded = save_widgets(conn, &created.id, moved)?;
            let positions: Vec<(i64, i64, i64, i64)> = reloaded
                .iter()
                .map(|saved_widget| {
                    (
                        saved_widget.x,
                        saved_widget.y,
                        saved_widget.w,
                        saved_widget.h,
                    )
                })
                .collect();
            assert_eq!(positions, [(3, 0, 5, 2), (6, 2, 3, 2)]);

            let mut invalid = reloaded.clone();
            invalid[0].x = 1;
            invalid[1].x = 10;
            assert!(save_widgets(conn, &created.id, invalid).is_err());
            assert_eq!(list_widgets(conn, &created.id)?[0].x, 3);
            Ok(())
        })
        .expect("repo calls");
    }
}
