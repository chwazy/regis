use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use serde_json::json;

use crate::audio::recording::{RecordingManager, DEFAULT_RETENTION_DAYS, SETTING_RETENTION_DAYS};
use regis_core::db::repo;
use regis_core::db::Db;
use regis_core::events::now_iso_utc;
use regis_core::sidecar::SidecarClient;

const TICK_INTERVAL: Duration = Duration::from_secs(60);
const GENERATE_TIMEOUT: Duration = Duration::from_secs(900);
const BRIEF_TIME_SETTING: &str = "brief.time";
const DEFAULT_BRIEF_MINUTES: u32 = 7 * 60 + 30;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LocalClock {
    pub date: String,
    pub minutes: u32,
}

pub(crate) trait SchedulerPort {
    async fn clock(&self) -> Result<LocalClock, String>;
    fn brief_minutes(&self) -> u32;
    fn has_brief(&self, date: &str) -> bool;
    async fn generate(&self) -> Result<(), String>;
}

pub fn parse_brief_time(value: Option<&str>) -> u32 {
    let parsed = value.and_then(|raw| {
        let (hours, minutes) = raw.trim().split_once(':')?;
        let hours: u32 = hours.parse().ok()?;
        let minutes: u32 = minutes.parse().ok()?;
        (hours < 24 && minutes < 60).then_some(hours * 60 + minutes)
    });
    parsed.unwrap_or(DEFAULT_BRIEF_MINUTES)
}

pub fn should_generate(clock: &LocalClock, brief_minutes: u32, has_brief: bool) -> bool {
    !has_brief && clock.minutes >= brief_minutes
}

pub(crate) async fn tick<P: SchedulerPort>(port: &P) -> Result<bool, String> {
    let clock = port.clock().await?;
    if !should_generate(&clock, port.brief_minutes(), port.has_brief(&clock.date)) {
        return Ok(false);
    }
    port.generate().await?;
    Ok(true)
}

struct LivePort {
    db: Arc<Db>,
    sidecar: SidecarClient,
}

impl SchedulerPort for LivePort {
    async fn clock(&self) -> Result<LocalClock, String> {
        self.sidecar
            .call::<LocalClock>("brief.clock", json!({}))
            .await
            .map_err(|error| error.to_string())
    }

    fn brief_minutes(&self) -> u32 {
        let setting = self
            .db
            .with_conn(|conn| repo::get_setting(conn, BRIEF_TIME_SETTING))
            .ok()
            .flatten();
        parse_brief_time(setting.as_deref())
    }

    fn has_brief(&self, date: &str) -> bool {
        self.db
            .with_conn(|conn| repo::get_brief_by_date(conn, date))
            .map(|brief| brief.is_some())
            .unwrap_or(false)
    }

    async fn generate(&self) -> Result<(), String> {
        self.sidecar
            .call_with_timeout::<serde_json::Value>("brief.generate", json!({}), GENERATE_TIMEOUT)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

/// La purge de l'audio tourne une fois par jour calendaire UTC (au premier tick de la journée).
pub fn purge_due(last_purge_date: Option<&str>, today: &str) -> bool {
    last_purge_date != Some(today)
}

fn retention_days(db: &Db) -> u32 {
    db.with_conn(|conn| repo::get_setting(conn, SETTING_RETENTION_DAYS))
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

async fn purge_audio(db: Arc<Db>, data_dir: PathBuf) {
    let purge = tokio::task::spawn_blocking(move || {
        let days = retention_days(&db);
        RecordingManager::purge_expired_audio(&db, &data_dir, days, SystemTime::now())
    })
    .await;
    match purge {
        Ok(Ok(0)) => {}
        Ok(Ok(count)) => eprintln!("[scheduler] audio purgé pour {count} enregistrement(s)"),
        Ok(Err(error)) => eprintln!("[scheduler] purge de l'audio impossible: {error}"),
        Err(error) => eprintln!("[scheduler] purge de l'audio interrompue: {error}"),
    }
}

pub async fn run(db: Arc<Db>, sidecar: SidecarClient, data_dir: PathBuf) {
    let port = LivePort {
        db: db.clone(),
        sidecar,
    };
    let mut interval = tokio::time::interval(TICK_INTERVAL);
    let mut last_purge_date: Option<String> = None;
    loop {
        interval.tick().await;
        if let Err(error) = tick(&port).await {
            eprintln!("[scheduler] daily brief not generated: {error}");
        }
        let today = now_iso_utc()[..10].to_owned();
        if purge_due(last_purge_date.as_deref(), &today) {
            purge_audio(db.clone(), data_dir.clone()).await;
            last_purge_date = Some(today);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    struct FakePort {
        clock: LocalClock,
        brief_minutes: u32,
        has_brief: bool,
        generated: Cell<u32>,
    }

    impl FakePort {
        fn at(minutes: u32, has_brief: bool) -> FakePort {
            FakePort {
                clock: LocalClock {
                    date: "2026-10-22".to_owned(),
                    minutes,
                },
                brief_minutes: parse_brief_time(Some("07:30")),
                has_brief,
                generated: Cell::new(0),
            }
        }
    }

    impl SchedulerPort for FakePort {
        async fn clock(&self) -> Result<LocalClock, String> {
            Ok(self.clock.clone())
        }

        fn brief_minutes(&self) -> u32 {
            self.brief_minutes
        }

        fn has_brief(&self, _date: &str) -> bool {
            self.has_brief
        }

        async fn generate(&self) -> Result<(), String> {
            self.generated.set(self.generated.get() + 1);
            Ok(())
        }
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    #[test]
    fn triggers_at_the_configured_time_without_a_brief() {
        let port = FakePort::at(7 * 60 + 30, false);

        assert_eq!(block_on(tick(&port)), Ok(true));
        assert_eq!(port.generated.get(), 1);
    }

    #[test]
    fn waits_before_the_configured_time() {
        let port = FakePort::at(7 * 60 + 29, false);

        assert_eq!(block_on(tick(&port)), Ok(false));
        assert_eq!(port.generated.get(), 0);
    }

    #[test]
    fn triggers_immediately_when_started_after_the_configured_time() {
        let port = FakePort::at(9 * 60, false);

        assert_eq!(block_on(tick(&port)), Ok(true));
        assert_eq!(port.generated.get(), 1);
    }

    #[test]
    fn does_nothing_when_the_brief_of_the_day_exists() {
        let port = FakePort::at(9 * 60, true);

        assert_eq!(block_on(tick(&port)), Ok(false));
        assert_eq!(port.generated.get(), 0);
    }

    #[test]
    fn the_audio_purge_runs_once_per_day() {
        assert!(purge_due(None, "2026-10-22"));
        assert!(!purge_due(Some("2026-10-22"), "2026-10-22"));
        assert!(purge_due(Some("2026-10-21"), "2026-10-22"));
    }

    #[test]
    fn parses_the_brief_time_setting_with_a_default() {
        assert_eq!(parse_brief_time(Some("06:05")), 6 * 60 + 5);
        assert_eq!(parse_brief_time(Some("25:00")), 7 * 60 + 30);
        assert_eq!(parse_brief_time(Some("nope")), 7 * 60 + 30);
        assert_eq!(parse_brief_time(None), 7 * 60 + 30);
    }
}
