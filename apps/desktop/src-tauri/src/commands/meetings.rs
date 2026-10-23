use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;
use url::Url;

use crate::AppState;
use regis_core::db::repo;
use regis_core::db::Db;
use regis_core::demo;
use regis_model::{Item, ItemKind};

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct OpenMeetingResult {
    pub opened: bool,
    pub url_host: String,
}

#[derive(Debug, thiserror::Error)]
pub enum MeetingError {
    #[error("événement introuvable : {0}")]
    NotFound(String),
    #[error("cet élément n'est pas un événement")]
    NotAnEvent,
    #[error("aucun lien de réunion")]
    NoJoinUrl,
    #[error("lien de réunion refusé : {0}")]
    InvalidUrl(String),
    #[error("ouverture impossible : {0}")]
    Open(String),
}

/// Pure : lit data_json.onlineMeetingUrl, exige un événement non annulé et une URL https absolue avec hôte.
pub fn meeting_join_url(item: &Item) -> Result<Url, MeetingError> {
    if item.kind != ItemKind::Event {
        return Err(MeetingError::NotAnEvent);
    }
    let cancelled = item
        .data_json
        .get("isCancelled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if cancelled {
        return Err(MeetingError::NoJoinUrl);
    }
    let raw = item
        .data_json
        .get("onlineMeetingUrl")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(MeetingError::NoJoinUrl)?;
    let url = Url::parse(raw).map_err(|error| MeetingError::InvalidUrl(error.to_string()))?;
    if url.scheme() != "https" {
        return Err(MeetingError::InvalidUrl(format!(
            "schéma {} non autorisé",
            url.scheme()
        )));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(MeetingError::InvalidUrl("hôte manquant".to_owned()));
    }
    Ok(url)
}

fn load_join_url(db: &Db, item_id: &str) -> Result<Url, MeetingError> {
    let item: Item = db
        .with_conn(|conn| repo::get(conn, item_id))
        .map_err(|error| MeetingError::Open(error.to_string()))?
        .ok_or_else(|| MeetingError::NotFound(item_id.to_owned()))?;
    meeting_join_url(&item)
}

/// Résout le lien depuis la base ; `open` n'est appelé que hors mode démo.
fn open_meeting_with<F>(
    db: &Db,
    item_id: &str,
    demo_mode: bool,
    open: F,
) -> Result<OpenMeetingResult, MeetingError>
where
    F: FnOnce(&Url) -> Result<(), String>,
{
    let url = load_join_url(db, item_id)?;
    let url_host = url.host_str().unwrap_or_default().to_owned();
    if demo_mode {
        return Ok(OpenMeetingResult {
            opened: false,
            url_host,
        });
    }
    open(&url).map_err(MeetingError::Open)?;
    Ok(OpenMeetingResult {
        opened: true,
        url_host,
    })
}

#[tauri::command]
pub async fn open_meeting(
    app: AppHandle,
    state: State<'_, AppState>,
    item_id: String,
) -> Result<OpenMeetingResult, String> {
    open_meeting_with(&state.db, &item_id, demo::is_enabled(), |url| {
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|error| error.to_string())
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use regis_core::db::repo::testing::{sample_connector, test_db};
    use regis_model::ItemUpsert;

    fn item(kind: ItemKind, data_json: Value) -> Item {
        Item {
            id: "i1".to_owned(),
            connector_id: "c1".to_owned(),
            kind,
            external_id: "e1".to_owned(),
            title: "Réunion".to_owned(),
            body_text: None,
            occurred_at: Some("2026-10-23T13:00:00.000Z".to_owned()),
            data_json,
            updated_at: "2026-10-22T00:00:00.000Z".to_owned(),
        }
    }

    fn event(url: Value) -> Item {
        item(ItemKind::Event, json!({ "onlineMeetingUrl": url }))
    }

    #[test]
    fn returns_the_https_url() {
        let url = meeting_join_url(&event(json!(
            "https://teams.microsoft.com/l/meetup-join/abc"
        )))
        .expect("valid");
        assert_eq!(url.host_str(), Some("teams.microsoft.com"));
    }

    #[test]
    fn no_link_is_no_join_url() {
        for data in [
            json!({}),
            json!({ "onlineMeetingUrl": null }),
            json!({ "onlineMeetingUrl": "  " }),
        ] {
            assert!(matches!(
                meeting_join_url(&item(ItemKind::Event, data)),
                Err(MeetingError::NoJoinUrl)
            ));
        }
    }

    #[test]
    fn refuses_non_https_and_unparsable_links() {
        for raw in [
            "http://teams.microsoft.com/l/meetup-join/abc",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "pas une url",
            "https://",
        ] {
            assert!(
                matches!(
                    meeting_join_url(&event(json!(raw))),
                    Err(MeetingError::InvalidUrl(_))
                ),
                "{raw}"
            );
        }
    }

    #[test]
    fn refuses_a_message_and_a_cancelled_event() {
        let message = item(
            ItemKind::Message,
            json!({ "onlineMeetingUrl": "https://teams.microsoft.com/x" }),
        );
        assert!(matches!(
            meeting_join_url(&message),
            Err(MeetingError::NotAnEvent)
        ));
        let cancelled = item(
            ItemKind::Event,
            json!({ "onlineMeetingUrl": "https://teams.microsoft.com/x", "isCancelled": true }),
        );
        assert!(matches!(
            meeting_join_url(&cancelled),
            Err(MeetingError::NoJoinUrl)
        ));
    }

    fn store_event(db: &Db, url: &str) -> String {
        db.with_conn(|conn| {
            repo::save_connector(conn, sample_connector("c1"))?;
            repo::upsert_items(
                conn,
                &[ItemUpsert {
                    connector_id: "c1".to_owned(),
                    kind: ItemKind::Event,
                    external_id: "e1".to_owned(),
                    title: "Réunion".to_owned(),
                    body_text: None,
                    occurred_at: Some("2026-10-23T13:00:00.000Z".to_owned()),
                    data_json: json!({ "onlineMeetingUrl": url }),
                    updated_at: "2026-10-22T00:00:00.000Z".to_owned(),
                }],
            )?;
            Ok(repo::list_items(conn, &repo::ItemFilter::default())?
                .remove(0)
                .id)
        })
        .expect("store")
    }

    #[test]
    fn unknown_id_is_not_found_and_never_opens() {
        let db = test_db("meetings-unknown");
        let mut called = false;
        let result = open_meeting_with(&db, "nope", false, |_| {
            called = true;
            Ok(())
        });
        assert!(matches!(result, Err(MeetingError::NotFound(_))));
        assert!(!called);
    }

    #[test]
    fn demo_mode_resolves_the_host_without_opening() {
        let db = test_db("meetings-demo");
        let id = store_event(&db, "https://teams.microsoft.com/l/meetup-join/demo");
        let mut called = false;
        let result = open_meeting_with(&db, &id, true, |_| {
            called = true;
            Ok(())
        })
        .expect("demo");
        assert!(!result.opened);
        assert_eq!(result.url_host, "teams.microsoft.com");
        assert!(!called);
    }

    #[test]
    fn opens_the_stored_https_url() {
        let db = test_db("meetings-open");
        let id = store_event(&db, "https://teams.microsoft.com/l/meetup-join/abc");
        let mut opened = None;
        let result = open_meeting_with(&db, &id, false, |url| {
            opened = Some(url.to_string());
            Ok(())
        })
        .expect("open");
        assert!(result.opened);
        assert_eq!(
            opened.as_deref(),
            Some("https://teams.microsoft.com/l/meetup-join/abc")
        );
    }

    #[test]
    fn a_stored_javascript_link_is_refused_before_opening() {
        let db = test_db("meetings-js");
        let id = store_event(&db, "javascript:alert(1)");
        let result = open_meeting_with(&db, &id, false, |_| panic!("must not open"));
        assert!(matches!(result, Err(MeetingError::InvalidUrl(_))));
    }
}
