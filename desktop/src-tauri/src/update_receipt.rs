use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::Path, time::{SystemTime, UNIX_EPOCH}};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub schema: u8,
    pub from: String,
    pub target: String,
    pub phase: String,
    pub reopen: bool,
    #[serde(default)]
    pub relaunch_pending: bool,
    pub reason: Option<String>,
}
fn unique() -> String {
    format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos())
}
pub fn read(path: &Path) -> Result<Option<Receipt>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() > 8192 { return Err("Desktop update result is too large.".into()); }
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| "Desktop update result is invalid.")?;
    if receipt.schema != 1 || !["installing", "installed", "failed"].contains(&receipt.phase.as_str()) {
        return Err("Desktop update result is unsupported.".into());
    }
    Ok(Some(receipt))
}

/// A durable result belongs to one app session, including an invalid result from another version.
pub fn take_session(path: &Path) -> Result<Option<Receipt>, String> {
    match read(path) {
        Ok(Some(receipt)) => {
            fs::remove_file(path).map_err(|error| format!("Desktop update result could not be cleared: {error}"))?;
            Ok(Some(receipt))
        }
        Ok(None) => Ok(None),
        Err(reason) => {
            fs::rename(path, path.with_extension(format!("{}.invalid", unique())))
                .map_err(|error| format!("{reason} Could not move it aside: {error}"))?;
            Err(reason)
        }
    }
}
pub fn clear_failed(path: &Path) -> Result<(), String> {
    if read(path)?.is_some_and(|receipt| receipt.phase == "failed") {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}
pub fn write(path: &Path, receipt: &Receipt) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Desktop result directory is unavailable.")?).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.new", unique()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec(receipt).map_err(|error| error.to_string())?).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn result_is_consumed_once_and_bad_result_moved_aside() {
        let root = std::env::temp_dir().join(format!("cotal-result-{}", unique()));
        fs::create_dir(&root).unwrap();
        let path = root.join("desktop-apply.json");
        let receipt = Receipt { schema: 1, from: "0.164.8".into(), target: "0.164.9".into(), phase: "installed".into(), reopen: true, relaunch_pending: true, reason: None };
        write(&path, &receipt).unwrap();
        assert_eq!(take_session(&path).unwrap().unwrap().target, "0.164.9");
        assert!(take_session(&path).unwrap().is_none());
        fs::write(&path, r#"{"schema":999,"future":true}"#).unwrap();
        assert!(take_session(&path).is_err());
        assert!(take_session(&path).unwrap().is_none());
        assert_eq!(fs::read_dir(&root).unwrap().filter(|file| file.as_ref().unwrap().path().extension().unwrap() == "invalid").count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_current_check_retires_failed_result_but_not_success() {
        let root = std::env::temp_dir().join(format!("cotal-result-{}", unique()));
        fs::create_dir(&root).unwrap();
        let path = root.join("desktop-apply.json");
        let mut receipt = Receipt { schema: 1, from: "0.164.8".into(), target: "0.164.9".into(), phase: "failed".into(), reopen: false, relaunch_pending: false, reason: Some("test".into()) };
        write(&path, &receipt).unwrap(); clear_failed(&path).unwrap(); assert!(!path.exists());
        receipt.phase = "installed".into(); write(&path, &receipt).unwrap(); clear_failed(&path).unwrap(); assert!(path.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
