use std::fs::File;
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use calamine::{open_workbook, Reader, Xlsx};
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("pdf extraction failed: {0}")]
    Pdf(String),
    #[error("docx extraction failed: {0}")]
    Docx(String),
    #[error("xlsx extraction failed: {0}")]
    Xlsx(String),
}

pub fn is_indexable_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "txt" | "md" | "csv" | "pdf" | "docx" | "xlsx"
    )
}

pub fn extract_text(path: &Path) -> Result<Option<String>, ExtractError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "txt" | "md" | "csv" => Ok(Some(
            String::from_utf8_lossy(&std::fs::read(path)?).into_owned(),
        )),
        "pdf" => extract_pdf(path).map(Some),
        "docx" => extract_docx(path).map(Some),
        "xlsx" => extract_xlsx(path).map(Some),
        _ => Ok(None),
    }
}

fn extract_pdf(path: &Path) -> Result<String, ExtractError> {
    let outcome = catch_unwind(AssertUnwindSafe(|| pdf_extract::extract_text(path)));
    match outcome {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(error)) => Err(ExtractError::Pdf(error.to_string())),
        Err(_) => Err(ExtractError::Pdf("the pdf parser panicked".to_owned())),
    }
}

fn extract_docx(path: &Path) -> Result<String, ExtractError> {
    let docx_error = |error: &dyn std::fmt::Display| ExtractError::Docx(error.to_string());
    let mut archive = zip::ZipArchive::new(File::open(path)?).map_err(|e| docx_error(&e))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| docx_error(&e))?
        .read_to_string(&mut xml)
        .map_err(|e| docx_error(&e))?;
    document_xml_text(&xml).map_err(|e| docx_error(&e))
}

fn document_xml_text(xml: &str) -> Result<String, quick_xml::Error> {
    let mut reader = XmlReader::from_str(xml);
    let mut output = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event()? {
            Event::Start(element) if element.local_name().as_ref() == b"t" => in_text = true,
            Event::End(element) => match element.local_name().as_ref() {
                b"t" => in_text = false,
                b"p" => output.push('\n'),
                _ => {}
            },
            Event::Empty(element) => match element.local_name().as_ref() {
                b"tab" => output.push('\t'),
                b"br" => output.push('\n'),
                _ => {}
            },
            Event::Text(text) if in_text => output.push_str(&text.decode()?),
            Event::GeneralRef(reference) if in_text => {
                if let Some(resolved) = resolve_reference(&reference.decode()?) {
                    output.push(resolved);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(output)
}

fn resolve_reference(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        numeric => {
            let digits = numeric.strip_prefix('#')?;
            let code = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => digits.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

fn extract_xlsx(path: &Path) -> Result<String, ExtractError> {
    let mut workbook: Xlsx<_> =
        open_workbook(path).map_err(|error| ExtractError::Xlsx(format!("{error}")))?;
    let mut output = String::new();
    for (_, range) in workbook.worksheets() {
        for row in range.rows() {
            let cells: Vec<String> = row
                .iter()
                .map(|cell| cell.to_string())
                .filter(|value| !value.is_empty())
                .collect();
            if !cells.is_empty() {
                output.push_str(&cells.join("\t"));
                output.push('\n');
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "FIXTURE-OK";

    fn fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../../tests/fixtures/files")
            .join(name)
    }

    #[test]
    fn supported_fixtures_contain_the_marker() {
        for name in ["sample.pdf", "sample.docx", "sample.xlsx", "sample.md"] {
            let text = extract_text(&fixture(name))
                .unwrap_or_else(|error| panic!("{name}: {error}"))
                .unwrap_or_else(|| panic!("{name}: not indexed"));
            assert!(text.contains(MARKER), "{name} text was {text:?}");
        }
    }

    #[test]
    fn unsupported_extension_is_not_indexed() {
        assert!(matches!(extract_text(&fixture("sample.dwg")), Ok(None)));
    }

    #[test]
    fn corrupt_documents_report_typed_errors() {
        let dir = std::env::temp_dir().join(format!("regis-extract-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        for name in ["broken.pdf", "broken.docx", "broken.xlsx"] {
            let path = dir.join(name);
            std::fs::write(&path, b"not a real document").expect("write");
            let error = extract_text(&path).expect_err(name);
            let matches_kind = match name {
                "broken.pdf" => matches!(error, ExtractError::Pdf(_)),
                "broken.docx" => matches!(error, ExtractError::Docx(_)),
                _ => matches!(error, ExtractError::Xlsx(_)),
            };
            assert!(matches_kind, "{name}: {error}");
        }
    }
}
