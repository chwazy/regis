use super::dictation::SILENCE_RMS;

pub const DEFAULT_CHUNK_SECONDS: u32 = 30;
pub const CUT_SEARCH_SECONDS: u32 = 5;

pub const WINDOWS_PER_SECOND: usize = 10;

/// `levels` : RMS par fenêtre de 100 ms du bloc courant. Renvoie l'index de fenêtre où couper
/// (le bloc émis contient les fenêtres `..index`), ou None tant que le bloc est plus court que
/// `chunk_seconds`. La coupure tombe sur la fenêtre la plus calme des `CUT_SEARCH_SECONDS`
/// dernières secondes (la plus tardive en cas d'égalité), sans jamais descendre sous la moitié du bloc.
pub fn pick_cut_point(levels: &[f32], chunk_seconds: u32) -> Option<usize> {
    let wanted = chunk_seconds.max(1) as usize * WINDOWS_PER_SECOND;
    if levels.len() < wanted {
        return None;
    }
    let search = CUT_SEARCH_SECONDS as usize * WINDOWS_PER_SECOND;
    let start = levels.len().saturating_sub(search).max(levels.len() / 2);
    let mut best = start;
    for (index, level) in levels.iter().enumerate().skip(start) {
        if *level <= levels[best] {
            best = index;
        }
    }
    Some(best)
}

pub fn is_silent(levels: &[f32]) -> bool {
    if levels.is_empty() {
        return true;
    }
    let mean = levels.iter().sum::<f32>() / levels.len() as f32;
    mean < SILENCE_RMS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_shorter_than_the_chunk_is_not_cut() {
        assert_eq!(pick_cut_point(&vec![0.1; 290], 30), None);
        assert_eq!(pick_cut_point(&[], 30), None);
    }

    #[test]
    fn the_quietest_window_of_the_last_five_seconds_is_chosen() {
        let mut levels = vec![0.1; 300];
        levels[271] = 0.001;
        levels[10] = 0.0; // hors de la zone de recherche
        assert_eq!(pick_cut_point(&levels, 30), Some(271));
    }

    #[test]
    fn ties_resolve_to_the_latest_quiet_window() {
        let levels = vec![0.05; 300];
        assert_eq!(pick_cut_point(&levels, 30), Some(299));
    }

    #[test]
    fn short_chunks_never_cut_in_the_first_half() {
        let mut levels = vec![0.1; 20];
        levels[0] = 0.0;
        let cut = pick_cut_point(&levels, 2).unwrap();
        assert!(cut >= 10, "{cut}");
    }

    #[test]
    fn silence_is_detected_on_the_mean_level() {
        assert!(is_silent(&vec![0.001; 100]));
        assert!(!is_silent(&vec![0.1; 100]));
        assert!(is_silent(&[]));
    }
}
