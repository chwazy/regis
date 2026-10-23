// Seule l'attribution est implémentée ; le diariseur sherpa-onnx n'est pas encore câblé.
#![allow(dead_code)]

use std::collections::BTreeMap;

use regis_model::TranscriptSegment;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeakerTurn {
    pub speaker: u32,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Pur : attribue à chaque segment le locuteur qui couvre la plus grande part de son intervalle, None si aucun.
/// Les tours d'un même locuteur se cumulent ; à égalité, le plus petit identifiant l'emporte.
pub fn assign_speakers(segments: &[TranscriptSegment], turns: &[SpeakerTurn]) -> Vec<Option<u32>> {
    segments
        .iter()
        .map(|segment| {
            let mut coverage: BTreeMap<u32, u64> = BTreeMap::new();
            for turn in turns {
                let start = segment.start_ms.max(turn.start_ms);
                let end = segment.end_ms.min(turn.end_ms);
                if end > start {
                    *coverage.entry(turn.speaker).or_insert(0) += end - start;
                }
            }
            coverage
                .into_iter()
                .fold(
                    None,
                    |best: Option<(u32, u64)>, (speaker, overlap)| match best {
                        Some((_, best_overlap)) if best_overlap >= overlap => best,
                        _ => Some((speaker, overlap)),
                    },
                )
                .map(|(speaker, _)| speaker)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use regis_model::SegmentSource;

    fn segment(start_ms: u64, end_ms: u64) -> TranscriptSegment {
        TranscriptSegment {
            source: SegmentSource::System,
            start_ms,
            end_ms,
            text: "x".into(),
        }
    }

    fn turn(speaker: u32, start_ms: u64, end_ms: u64) -> SpeakerTurn {
        SpeakerTurn {
            speaker,
            start_ms,
            end_ms,
        }
    }

    #[test]
    fn majority_speaker_wins() {
        let turns = [turn(0, 0, 3_000), turn(1, 3_000, 10_000)];
        assert_eq!(
            assign_speakers(&[segment(0, 10_000)], &turns),
            vec![Some(1)]
        );
    }

    #[test]
    fn segment_without_overlapping_turn_is_none() {
        let turns = [turn(0, 0, 3_000)];
        assert_eq!(
            assign_speakers(&[segment(5_000, 8_000)], &turns),
            vec![None]
        );
        assert_eq!(assign_speakers(&[segment(0, 1_000)], &[]), vec![None]);
    }

    #[test]
    fn touching_boundary_is_not_an_overlap() {
        assert_eq!(
            assign_speakers(&[segment(3_000, 5_000)], &[turn(0, 0, 3_000)]),
            vec![None]
        );
    }

    #[test]
    fn turns_of_the_same_speaker_accumulate() {
        let turns = [
            turn(0, 0, 3_000),
            turn(1, 3_000, 6_000),
            turn(0, 6_000, 9_000),
        ];
        assert_eq!(
            assign_speakers(&[segment(0, 10_000)], &turns),
            vec![Some(0)]
        );
    }

    #[test]
    fn tie_goes_to_the_lowest_speaker_id() {
        let turns = [turn(2, 0, 5_000), turn(1, 5_000, 10_000)];
        assert_eq!(
            assign_speakers(&[segment(0, 10_000)], &turns),
            vec![Some(1)]
        );
    }

    #[test]
    fn zero_length_segment_is_none() {
        assert_eq!(
            assign_speakers(&[segment(2_000, 2_000)], &[turn(0, 0, 5_000)]),
            vec![None]
        );
    }

    #[test]
    fn each_segment_is_attributed_independently() {
        let turns = [turn(0, 0, 4_000), turn(1, 4_000, 8_000)];
        let segments = [
            segment(0, 3_000),
            segment(3_000, 8_000),
            segment(9_000, 10_000),
        ];
        assert_eq!(
            assign_speakers(&segments, &turns),
            vec![Some(0), Some(1), None]
        );
    }
}
