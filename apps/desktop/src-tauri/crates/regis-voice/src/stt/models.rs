use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::SttError;

pub struct SttModelSpec {
    pub id: &'static str,
    pub file_name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

// Empreintes et tailles lues le 2026-10-22 dans les métadonnées LFS de Hugging Face :
// https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main (champs `lfs.oid` et `size`).
pub const STT_MODELS: &[SttModelSpec] = &[
    SttModelSpec {
        id: "large-v3-turbo-q5_0",
        file_name: "ggml-large-v3-turbo-q5_0.bin",
        url:
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        size_bytes: 574_041_195,
    },
    SttModelSpec {
        id: "large-v3-turbo-q8_0",
        file_name: "ggml-large-v3-turbo-q8_0.bin",
        url:
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
        sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
        size_bytes: 874_188_075,
    },
    SttModelSpec {
        id: "small-q8_0",
        file_name: "ggml-small-q8_0.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin",
        sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
        size_bytes: 264_464_607,
    },
];

pub const DEFAULT_STT_MODEL: &str = "large-v3-turbo-q5_0";

const MODELS_DIR: &str = "stt-models";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

pub fn find_model(id: &str) -> Option<&'static SttModelSpec> {
    STT_MODELS.iter().find(|spec| spec.id == id)
}

pub fn model_path(data_dir: &Path, spec: &SttModelSpec) -> PathBuf {
    data_dir.join(MODELS_DIR).join(spec.file_name)
}

fn part_path(final_path: &Path) -> PathBuf {
    let mut name = final_path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn verify_sha256(path: &Path, expected_hex: &str) -> Result<bool, SttError> {
    let io_error = |error: std::io::Error| SttError::Load(error.to_string());
    let mut file = std::fs::File::open(path).map_err(io_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()).eq_ignore_ascii_case(expected_hex))
}

async fn fetch_to_part(
    spec: &SttModelSpec,
    part: &Path,
    on_progress: &(impl Fn(u64, u64) + Send),
) -> Result<String, SttError> {
    let download_error = |error: &dyn std::fmt::Display| SttError::Download(error.to_string());
    let response = reqwest::Client::new()
        .get(spec.url)
        .send()
        .await
        .map_err(|e| download_error(&e))?
        .error_for_status()
        .map_err(|e| download_error(&e))?;
    let total = response.content_length().unwrap_or(spec.size_bytes);
    let mut file = tokio::fs::File::create(part)
        .await
        .map_err(|e| download_error(&e))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut last_report = Instant::now();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| download_error(&e))?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| download_error(&e))?;
        downloaded += chunk.len() as u64;
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            last_report = Instant::now();
            on_progress(downloaded, total);
        }
    }
    file.flush().await.map_err(|e| download_error(&e))?;
    drop(file);
    on_progress(downloaded, total);
    Ok(hex(&hasher.finalize()))
}

/// Télécharge vers `<fichier>.part`, vérifie l'empreinte, puis renomme. Aucun fichier final
/// ni `.part` ne survit à un échec.
pub async fn download_model(
    spec: &SttModelSpec,
    data_dir: &Path,
    on_progress: impl Fn(u64, u64) + Send,
) -> Result<PathBuf, SttError> {
    let final_path = model_path(data_dir, spec);
    let part = part_path(&final_path);
    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| SttError::Download(error.to_string()))?;
    }
    let result = fetch_to_part(spec, &part, &on_progress).await;
    let digest = match result {
        Ok(digest) => digest,
        Err(error) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(error);
        }
    };
    if !digest.eq_ignore_ascii_case(spec.sha256) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(SttError::ModelCorrupt(spec.id.to_owned()));
    }
    tokio::fs::rename(&part, &final_path)
        .await
        .map_err(|error| SttError::Download(error.to_string()))?;
    Ok(final_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicU64, Ordering};

    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::service::service_fn;
    use hyper::{Request, Response};
    use hyper_util::rt::TokioIo;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("regis-stt-{name}-{}", ulid::Ulid::generate()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn catalog_has_the_three_pinned_models() {
        let ids: Vec<_> = STT_MODELS.iter().map(|spec| spec.id).collect();
        assert_eq!(
            ids,
            ["large-v3-turbo-q5_0", "large-v3-turbo-q8_0", "small-q8_0"]
        );
        assert!(STT_MODELS
            .iter()
            .all(|spec| spec.sha256.len() == 64
                && spec.sha256.chars().all(|c| c.is_ascii_hexdigit())));
        assert!(find_model(DEFAULT_STT_MODEL).is_some());
        assert!(find_model("inconnu").is_none());
    }

    #[test]
    fn model_path_ends_with_stt_models_file_name() {
        let spec = find_model("small-q8_0").unwrap();
        let path = model_path(Path::new("data"), spec);
        assert!(path.ends_with(Path::new("stt-models").join(spec.file_name)));
    }

    #[test]
    fn verify_sha256_detects_a_modified_byte() {
        let dir = temp_dir("verify");
        let file = dir.join("model.bin");
        std::fs::write(&file, b"abc").unwrap();
        // SHA-256("abc")
        let known = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify_sha256(&file, known).unwrap());
        std::fs::write(&file, b"abd").unwrap();
        assert!(!verify_sha256(&file, known).unwrap());
    }

    async fn serve(body: &'static [u8]) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let service = service_fn(|_request: Request<hyper::body::Incoming>| async {
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(body))))
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        format!("http://{address}/model.bin")
    }

    fn leaked_spec(url: String, sha256: &str, size: u64) -> &'static SttModelSpec {
        Box::leak(Box::new(SttModelSpec {
            id: "test",
            file_name: "ggml-test.bin",
            url: Box::leak(url.into_boxed_str()),
            sha256: Box::leak(sha256.to_owned().into_boxed_str()),
            size_bytes: size,
        }))
    }

    #[tokio::test]
    async fn corrupt_download_leaves_no_file_behind() {
        let url = serve(b"contenu inattendu").await;
        let spec = leaked_spec(url, &"0".repeat(64), 17);
        let dir = temp_dir("corrupt");
        let result = download_model(spec, &dir, |_, _| {}).await;
        assert!(matches!(result, Err(SttError::ModelCorrupt(_))));
        let final_path = model_path(&dir, spec);
        assert!(!final_path.exists());
        assert!(!part_path(&final_path).exists());
    }

    #[tokio::test]
    async fn valid_download_is_renamed_and_reports_progress() {
        let url = serve(b"abc").await;
        let spec = leaked_spec(
            url,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            3,
        );
        let dir = temp_dir("valid");
        let last = AtomicU64::new(0);
        let path = download_model(spec, &dir, |done, _| last.store(done, Ordering::SeqCst))
            .await
            .unwrap();
        assert!(path.is_file());
        assert!(!part_path(&path).exists());
        assert_eq!(last.load(Ordering::SeqCst), 3);
    }
}
