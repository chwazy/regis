use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

pub const EMBEDDING_DIMENSION: usize = 1024;
pub const EMBED_BATCH_SIZE: usize = 16;
pub const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
pub const DEFAULT_EMBEDDING_MODEL: &str = "bge-m3";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("ollama is unreachable")]
    Unreachable,
    #[error("embedding model {0} is not available in ollama")]
    ModelMissing(String),
    #[error("embedding dimension mismatch: expected {expected}, got {got}")]
    BadDimension { expected: usize, got: usize },
    #[error("ollama request failed: {0}")]
    Http(String),
}

#[derive(Debug, Clone)]
pub struct OllamaEmbedder {
    pub url: String,
    pub model: String,
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

impl OllamaEmbedder {
    pub async fn embed(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| EmbedError::Http(error.to_string()))?;
        let mut vectors = Vec::with_capacity(inputs.len());
        for batch in inputs.chunks(EMBED_BATCH_SIZE) {
            vectors.extend(self.embed_batch(&client, batch).await?);
        }
        Ok(vectors)
    }

    async fn embed_batch(
        &self,
        client: &reqwest::Client,
        batch: &[String],
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        let endpoint = format!("{}/api/embed", self.url.trim_end_matches('/'));
        let response = client
            .post(endpoint)
            .json(&EmbedRequest {
                model: &self.model,
                input: batch,
            })
            .send()
            .await
            .map_err(|error| {
                if error.is_connect() || error.is_timeout() {
                    EmbedError::Unreachable
                } else {
                    EmbedError::Http(error.to_string())
                }
            })?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Err(EmbedError::ModelMissing(self.model.clone()));
        }
        if !status.is_success() {
            return Err(EmbedError::Http(format!("status {status}")));
        }
        let body: EmbedResponse = response
            .json()
            .await
            .map_err(|error| EmbedError::Http(error.to_string()))?;
        if body.embeddings.len() != batch.len() {
            return Err(EmbedError::Http(format!(
                "expected {} embeddings, got {}",
                batch.len(),
                body.embeddings.len()
            )));
        }
        for vector in &body.embeddings {
            if vector.len() != EMBEDDING_DIMENSION {
                return Err(EmbedError::BadDimension {
                    expected: EMBEDDING_DIMENSION,
                    got: vector.len(),
                });
            }
        }
        Ok(body.embeddings)
    }
}

pub fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|component| component.to_le_bytes())
        .collect()
}

#[cfg(any(test, feature = "test-util"))]
pub mod testing {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::{OllamaEmbedder, EMBEDDING_DIMENSION};

    pub type VectorFn = Arc<dyn Fn(&str) -> Vec<f32> + Send + Sync>;

    pub struct MockOllama {
        pub url: String,
        pub requests: Arc<AtomicUsize>,
    }

    impl MockOllama {
        pub fn start() -> MockOllama {
            MockOllama::start_with(Arc::new(bag_of_words_vector))
        }

        pub fn start_with(vector_for: VectorFn) -> MockOllama {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock ollama");
            let url = format!("http://{}", listener.local_addr().expect("address"));
            let requests = Arc::new(AtomicUsize::new(0));
            let counter = requests.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let counter = counter.clone();
                    let vector_for = vector_for.clone();
                    std::thread::spawn(move || serve(stream, &counter, &vector_for));
                }
            });
            MockOllama { url, requests }
        }

        pub fn embedder(&self) -> OllamaEmbedder {
            OllamaEmbedder {
                url: self.url.clone(),
                model: "bge-m3".to_owned(),
            }
        }

        pub fn request_count(&self) -> usize {
            self.requests.load(Ordering::SeqCst)
        }
    }

    pub fn unreachable_embedder() -> OllamaEmbedder {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("address"));
        drop(listener);
        OllamaEmbedder {
            url,
            model: "bge-m3".to_owned(),
        }
    }

    pub fn bag_of_words_vector(text: &str) -> Vec<f32> {
        let mut vector = vec![0.0_f32; EMBEDDING_DIMENSION];
        for word in text
            .to_lowercase()
            .split(|character: char| !character.is_alphanumeric())
            .filter(|word| !word.is_empty())
        {
            let hash = word.bytes().fold(5381_usize, |acc, byte| {
                acc.wrapping_mul(33) ^ usize::from(byte)
            });
            vector[hash % EMBEDDING_DIMENSION] += 1.0;
        }
        vector
    }

    fn serve(stream: TcpStream, counter: &AtomicUsize, vector_for: &VectorFn) {
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        loop {
            let mut content_length = 0_usize;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break;
                }
                if let Some(value) = trimmed.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0_u8; content_length];
            if reader.read_exact(&mut body).is_err() {
                return;
            }
            counter.fetch_add(1, Ordering::SeqCst);
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            let embeddings: Vec<Vec<f32>> = request["input"]
                .as_array()
                .map(|inputs| {
                    inputs
                        .iter()
                        .map(|input| vector_for(input.as_str().unwrap_or_default()))
                        .collect()
                })
                .unwrap_or_default();
            let payload = serde_json::json!({ "embeddings": embeddings }).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
                payload.len()
            );
            if writer.write_all(response.as_bytes()).is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::testing::{unreachable_embedder, MockOllama};
    use super::*;

    #[tokio::test]
    async fn wrong_dimension_is_rejected() {
        let mock = MockOllama::start_with(Arc::new(|_| vec![0.5; 768]));
        let error = mock
            .embedder()
            .embed(&["hello".to_owned()])
            .await
            .expect_err("dimension error");
        assert!(matches!(
            error,
            EmbedError::BadDimension {
                expected: 1024,
                got: 768
            }
        ));
    }

    #[tokio::test]
    async fn unreachable_server_is_reported() {
        let error = unreachable_embedder()
            .embed(&["hello".to_owned()])
            .await
            .expect_err("unreachable");
        assert!(matches!(error, EmbedError::Unreachable));
    }

    #[tokio::test]
    async fn inputs_are_sent_in_batches_of_sixteen() {
        let mock = MockOllama::start();
        let inputs: Vec<String> = (0..40).map(|index| format!("text {index}")).collect();
        let vectors = mock.embedder().embed(&inputs).await.expect("embed");
        assert_eq!(vectors.len(), 40);
        assert_eq!(vectors[0].len(), EMBEDDING_DIMENSION);
        assert_eq!(mock.request_count(), 3);
    }
}
