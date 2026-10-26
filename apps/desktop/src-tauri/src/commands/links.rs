use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use regis_core::demo;

const ALLOWED_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

fn external_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|error| format!("Lien invalide : {error}"))?;
    if ALLOWED_SCHEMES.contains(&url.scheme()) {
        Ok(url)
    } else {
        Err(format!("Lien non pris en charge : {}", url.scheme()))
    }
}

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<bool, String> {
    let url = external_url(&url)?;
    if demo::is_enabled() {
        return Ok(false);
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::external_url;

    #[test]
    fn only_web_and_mail_links_are_opened() {
        assert!(external_url("https://example.com/a?b=1").is_ok());
        assert!(external_url(" http://localhost:3000 ").is_ok());
        assert!(external_url("mailto:someone@example.com").is_ok());
        assert!(external_url("file:///C:/Windows/System32/cmd.exe").is_err());
        assert!(external_url("javascript:alert(1)").is_err());
        assert!(external_url("relative/path").is_err());
    }
}
