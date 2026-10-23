pub const DEFAULT_TARGET: usize = 1000;
pub const DEFAULT_OVERLAP: usize = 150;

pub fn chunk_text(text: &str, target: usize, overlap: usize) -> Vec<String> {
    let characters: Vec<char> = text.chars().collect();
    let target = target.max(1);
    let overlap = overlap.min(target / 2);
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < characters.len() {
        let window_end = (start + target).min(characters.len());
        let end = if window_end == characters.len() {
            window_end
        } else {
            break_point(&characters, start, window_end)
        };
        let chunk: String = characters[start..end].iter().collect();
        if !chunk.trim().is_empty() {
            chunks.push(chunk);
        }
        if end == characters.len() {
            break;
        }
        start = (end - overlap).max(start + 1);
    }
    chunks
}

fn break_point(characters: &[char], start: usize, window_end: usize) -> usize {
    let earliest = start + (window_end - start) / 2;
    let paragraph_break = (earliest + 1..window_end)
        .rev()
        .find(|&index| characters[index - 1] == '\n' && characters[index] == '\n');
    if let Some(index) = paragraph_break {
        return index + 1;
    }
    let whitespace_break = (earliest..window_end)
        .rev()
        .find(|&index| characters[index].is_whitespace());
    whitespace_break.map_or(window_end, |index| index + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(length: usize) -> String {
        "lorem ipsum "
            .repeat(length / 12 + 1)
            .chars()
            .take(length)
            .collect()
    }

    #[test]
    fn splits_long_text_into_overlapping_chunks() {
        let chunks = chunk_text(&words(2500), DEFAULT_TARGET, DEFAULT_OVERLAP);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 1000));
        for pair in chunks.windows(2) {
            let characters: Vec<char> = pair[0].chars().collect();
            let tail: String = characters[characters.len() - 100..].iter().collect();
            assert!(
                pair[1].starts_with(&pair[0][pair[0].len() - 150..]),
                "chunks must overlap"
            );
            assert!(pair[1].contains(&tail), "chunks must share 100+ characters");
        }
    }

    #[test]
    fn splits_without_any_whitespace() {
        let text = "x".repeat(2500);
        let chunks = chunk_text(&text, DEFAULT_TARGET, DEFAULT_OVERLAP);
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 1000));
    }

    #[test]
    fn prefers_paragraph_boundaries() {
        let first = "a".repeat(700);
        let second = "b".repeat(700);
        let chunks = chunk_text(
            &format!("{first}\n\n{second}"),
            DEFAULT_TARGET,
            DEFAULT_OVERLAP,
        );
        assert_eq!(chunks[0], format!("{first}\n\n"));
    }

    #[test]
    fn short_and_empty_inputs() {
        assert_eq!(chunk_text("hello", 1000, 150), vec!["hello".to_owned()]);
        assert!(chunk_text("  \n ", 1000, 150).is_empty());
        assert!(chunk_text("", 1000, 150).is_empty());
    }
}
