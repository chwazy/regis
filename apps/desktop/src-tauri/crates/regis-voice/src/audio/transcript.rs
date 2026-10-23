use regis_model::{SegmentSource, TranscriptSegment};

/// Deux segments du même canal espacés de moins que cela restent dans le même tour de parole.
const MERGE_GAP_MS: u64 = 2_000;

pub fn speaker_label(source: SegmentSource) -> &'static str {
    match source {
        SegmentSource::Mic => "Moi",
        SegmentSource::System => "Participants",
    }
}

fn clock(ms: u64) -> String {
    let seconds = ms / 1_000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3_600,
        seconds % 3_600 / 60,
        seconds % 60
    )
}

struct Turn {
    source: SegmentSource,
    start_ms: u64,
    end_ms: u64,
    text: String,
}

/// Trie par start_ms, fusionne les segments consécutifs du même canal espacés de moins de 2 s,
/// une ligne par tour de parole : "**[hh:mm:ss] Moi** : texte".
pub fn render_transcript(segments: &[TranscriptSegment]) -> String {
    let mut ordered: Vec<&TranscriptSegment> = segments
        .iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .collect();
    ordered.sort_by_key(|segment| segment.start_ms);
    let mut turns: Vec<Turn> = Vec::new();
    for segment in ordered {
        let text = segment.text.trim();
        if let Some(turn) = turns.last_mut() {
            let gap = segment.start_ms.saturating_sub(turn.end_ms);
            if turn.source == segment.source && gap < MERGE_GAP_MS {
                turn.text.push(' ');
                turn.text.push_str(text);
                turn.end_ms = turn.end_ms.max(segment.end_ms);
                continue;
            }
        }
        turns.push(Turn {
            source: segment.source,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            text: text.to_owned(),
        });
    }
    turns
        .iter()
        .map(|turn| {
            format!(
                "**[{}] {}** : {}",
                clock(turn.start_ms),
                speaker_label(turn.source),
                turn.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(source: SegmentSource, start_ms: u64, end_ms: u64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            source,
            start_ms,
            end_ms,
            text: text.to_owned(),
        }
    }

    fn sample() -> Vec<TranscriptSegment> {
        vec![
            segment(SegmentSource::Mic, 0, 1_000, "Bonjour"),
            segment(SegmentSource::Mic, 1_500, 2_500, "à tous"),
            segment(SegmentSource::System, 4_000, 5_000, "Bonjour Dylan"),
        ]
    }

    #[test]
    fn consecutive_segments_of_one_channel_form_a_single_line() {
        assert_eq!(
            render_transcript(&sample()),
            "**[00:00:00] Moi** : Bonjour à tous\n**[00:00:04] Participants** : Bonjour Dylan"
        );
    }

    #[test]
    fn input_order_does_not_matter() {
        let mut shuffled = sample();
        shuffled.reverse();
        assert_eq!(render_transcript(&shuffled), render_transcript(&sample()));
    }

    #[test]
    fn a_pause_of_two_seconds_starts_a_new_line() {
        let segments = vec![
            segment(SegmentSource::Mic, 0, 1_000, "Un"),
            segment(SegmentSource::Mic, 3_000, 4_000, "Deux"),
        ];
        assert_eq!(
            render_transcript(&segments),
            "**[00:00:00] Moi** : Un\n**[00:00:03] Moi** : Deux"
        );
    }

    #[test]
    fn alternating_channels_alternate_lines_and_hours_are_formatted() {
        let segments = vec![
            segment(SegmentSource::System, 3_725_000, 3_726_000, "Fin"),
            segment(SegmentSource::Mic, 3_724_000, 3_724_500, "Début"),
        ];
        assert_eq!(
            render_transcript(&segments),
            "**[01:02:04] Moi** : Début\n**[01:02:05] Participants** : Fin"
        );
        assert_eq!(render_transcript(&[]), "");
    }
}
