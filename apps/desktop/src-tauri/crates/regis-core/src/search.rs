use std::collections::HashMap;

use regis_model::SearchHit;

use crate::db::repo::RepoError;
use crate::db::Db;
use crate::files::embed::{vector_to_blob, OllamaEmbedder};

const RANK_POOL: usize = 50;
const RRF_OFFSET: f64 = 60.0;

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error(transparent)]
    Repo(#[from] RepoError),
}

impl From<rusqlite::Error> for SearchError {
    fn from(error: rusqlite::Error) -> Self {
        SearchError::Repo(RepoError::Sqlite(error))
    }
}

pub async fn search_chunks(
    db: &Db,
    embedder: Option<&OllamaEmbedder>,
    query: &str,
    k: usize,
) -> Result<Vec<SearchHit>, SearchError> {
    let query_vector = match embedder {
        Some(embedder) if !query.trim().is_empty() => embedder
            .embed(&[query.to_owned()])
            .await
            .ok()
            .and_then(|vectors| vectors.into_iter().next()),
        _ => None,
    };
    search_with_vector(db, query, query_vector.as_deref(), k)
}

pub fn search_with_vector(
    db: &Db,
    query: &str,
    query_vector: Option<&[f32]>,
    k: usize,
) -> Result<Vec<SearchHit>, SearchError> {
    let full_text = match fts_expression(query) {
        Some(expression) => full_text_ranking(db, &expression)?,
        None => Vec::new(),
    };
    let semantic = match query_vector {
        Some(vector) => vector_ranking(db, vector)?,
        None => Vec::new(),
    };
    let mut scores: HashMap<i64, f64> = HashMap::new();
    for ranking in [&full_text, &semantic] {
        for (position, chunk_id) in ranking.iter().enumerate() {
            *scores.entry(*chunk_id).or_default() += 1.0 / (RRF_OFFSET + (position + 1) as f64);
        }
    }
    let mut ordered: Vec<(i64, f64)> = scores.into_iter().collect();
    ordered.sort_by(|left, right| right.1.total_cmp(&left.1).then(left.0.cmp(&right.0)));
    ordered.truncate(k);
    Ok(db.with_conn(|conn| {
        let mut statement =
            conn.prepare("SELECT owner_type, owner_id, text FROM chunks WHERE id = ?1")?;
        let mut hits = Vec::with_capacity(ordered.len());
        for (chunk_id, score) in &ordered {
            let (owner_type, owner_id, text) = statement.query_row([chunk_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            hits.push(SearchHit {
                chunk_id: *chunk_id,
                owner_type,
                owner_id,
                text,
                score: *score,
            });
        }
        Ok(hits)
    })?)
}

fn fts_expression(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{term}\""))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

fn full_text_ranking(db: &Db, expression: &str) -> Result<Vec<i64>, RepoError> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )?;
        let rows = statement.query_map(rusqlite::params![expression, RANK_POOL as i64], |row| {
            row.get(0)
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<i64>>>()?)
    })
}

fn vector_ranking(db: &Db, vector: &[f32]) -> Result<Vec<i64>, RepoError> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT rowid FROM chunks_vec WHERE embedding MATCH ?1 AND k = ?2 ORDER BY distance",
        )?;
        let rows = statement.query_map(
            rusqlite::params![vector_to_blob(vector), RANK_POOL as i64],
            |row| row.get(0),
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<i64>>>()?)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::testing::test_db;
    use crate::files::embed::testing::{unreachable_embedder, MockOllama};
    use crate::files::embed::EMBEDDING_DIMENSION;

    async fn seed(db: &Db, mock: &MockOllama, texts: &[&str]) {
        let inputs: Vec<String> = texts.iter().map(|text| (*text).to_owned()).collect();
        let vectors = mock.embedder().embed(&inputs).await.expect("embed");
        db.with_conn(|conn| {
            for (ordinal, text) in texts.iter().enumerate() {
                conn.execute(
                    "INSERT INTO chunks (owner_type, owner_id, ord, text) VALUES ('file', 'f1', ?1, ?2)",
                    rusqlite::params![ordinal as i64, text],
                )?;
                conn.execute(
                    "INSERT INTO chunks_vec (rowid, embedding) VALUES (?1, ?2)",
                    rusqlite::params![conn.last_insert_rowid(), vector_to_blob(&vectors[ordinal])],
                )?;
            }
            Ok(())
        })
        .expect("seed");
        assert_eq!(vectors[0].len(), EMBEDDING_DIMENSION);
    }

    const CORPUS: [&str; 4] = [
        "maintenance schedule for the packaging line and spare parts",
        "invoice summary for the third quarter including hours and materials",
        "the zirconium sensor datasheet lists the supply voltage range",
        "meeting notes about the offer for the dairy customer",
    ];

    #[tokio::test]
    async fn exact_word_in_a_single_chunk_ranks_first() {
        let db = test_db("search-exact");
        let mock = MockOllama::start();
        seed(&db, &mock, &CORPUS).await;
        let hits = search_chunks(&db, Some(&mock.embedder()), "zirconium", 5)
            .await
            .expect("search");
        assert!(!hits.is_empty());
        assert!(hits[0].text.contains("zirconium"));
        assert_eq!(hits[0].owner_type, "file");
    }

    #[tokio::test]
    async fn falls_back_to_full_text_when_ollama_is_down() {
        let db = test_db("search-fallback");
        let mock = MockOllama::start();
        seed(&db, &mock, &CORPUS).await;
        let hits = search_chunks(&db, Some(&unreachable_embedder()), "invoice quarter", 5)
            .await
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].text.starts_with("invoice summary"));
    }

    #[tokio::test]
    async fn punctuation_in_the_query_does_not_break_full_text_search() {
        let db = test_db("search-punctuation");
        let mock = MockOllama::start();
        seed(&db, &mock, &CORPUS).await;
        let hits = search_chunks(
            &db,
            Some(&mock.embedder()),
            "\"offer\" (dairy) -customer*",
            3,
        )
        .await
        .expect("search");
        assert!(hits[0].text.contains("dairy"));
    }

    #[tokio::test]
    async fn without_an_embedder_search_is_full_text_only_and_calls_nothing() {
        let db = test_db("search-off");
        let mock = MockOllama::start();
        seed(&db, &mock, &CORPUS).await;
        let requests_before = mock.request_count();
        let hits = search_chunks(&db, None, "zirconium", 5)
            .await
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].text.contains("zirconium"));
        assert_eq!(mock.request_count(), requests_before);
    }
}
