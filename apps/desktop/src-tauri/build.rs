use std::{env, fs, path::PathBuf};

const EXTERNAL_BINARIES: [&str; 2] = ["regis-sidecar", "regis-odoo-mcp"];

fn main() {
    ensure_dev_binary_placeholders();
    tauri_build::build();
}

fn ensure_dev_binary_placeholders() {
    if env::var("PROFILE").as_deref() == Ok("release") {
        return;
    }
    let (Ok(manifest_dir), Ok(target_triple)) =
        (env::var("CARGO_MANIFEST_DIR"), env::var("TARGET"))
    else {
        return;
    };
    let extension = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let binaries_dir = PathBuf::from(manifest_dir).join("binaries");
    for basename in EXTERNAL_BINARIES {
        let placeholder = binaries_dir.join(format!("{basename}-{target_triple}{extension}"));
        if !placeholder.exists() {
            let _ = fs::create_dir_all(&binaries_dir);
            let _ = fs::write(&placeholder, b"");
        }
    }
}
