use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

pub const REGIS_EVENT_CHANNEL: &str = "regis://event";

#[derive(Serialize, Clone)]
pub struct RegisEvent {
    pub topic: String,
    pub payload: Value,
    pub at: String,
}

pub trait EventSink: Send + Sync + 'static {
    fn publish(&self, event: RegisEvent);
}

#[derive(Clone)]
pub struct EventBus {
    sink: Arc<dyn EventSink>,
}

impl EventBus {
    pub fn new(sink: Arc<dyn EventSink>) -> EventBus {
        EventBus { sink }
    }

    pub fn emit<T: Serialize>(&self, topic: &str, payload: &T) {
        let Ok(payload) = serde_json::to_value(payload) else {
            eprintln!("[events] payload for {topic} is not serializable");
            return;
        };
        self.sink.publish(RegisEvent {
            topic: topic.to_owned(),
            payload,
            at: now_iso_utc(),
        });
    }
}

pub fn now_iso_utc() -> String {
    iso_utc(SystemTime::now())
}

pub fn iso_utc(time: SystemTime) -> String {
    let since_epoch = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since_epoch.as_secs();
    let (year, month, day) = civil_from_days(seconds / 86_400);
    let seconds_of_day = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds_of_day / 3_600,
        seconds_of_day % 3_600 / 60,
        seconds_of_day % 60,
        since_epoch.subsec_millis()
    )
}

fn civil_from_days(days_since_epoch: u64) -> (u64, u64, u64) {
    let shifted = days_since_epoch + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn formats_epoch_and_a_known_instant() {
        assert_eq!(iso_utc(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let instant = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        assert_eq!(iso_utc(instant), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn handles_leap_day() {
        let instant = UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert_eq!(iso_utc(instant), "2024-02-29T00:00:00.000Z");
    }
}
