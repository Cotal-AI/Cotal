use serde::{Deserialize, Serialize};
use std::path::Path;

pub const APP_ID: &str = "ai.cotal.desktop";

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Preferences {
    pub login: Option<bool>,
    pub recovered: bool,
    pub connected: bool,
    pub relocation_declined: bool,
    pub pin_offered: bool,
    pub close_explained: bool,
}

/// Load startup preferences without discarding an unreadable file.
pub fn load_preferences(path: &Path) -> Result<(Preferences, Option<String>), String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Preferences::default(), None)),
        Err(error) => return Err(error.to_string()),
    };
    if let Ok(preferences) = serde_json::from_slice(&bytes) { return Ok((preferences, None)); }
    // Reserve a fresh name so an earlier recovery is never overwritten.
    for index in 0.. {
        let backup = path.with_extension(format!("json.invalid.{index}"));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&backup) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
                std::fs::remove_file(path).map_err(|error| error.to_string())?;
                return Ok((Preferences { recovered: true, ..Preferences::default() }, Some(format!("Desktop preferences could not be read. The original file was kept at {}. Cotal is using defaults. No login setting was changed.", backup.display()))));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    unreachable!()
}

impl Preferences {
    pub fn login_enabled(&self) -> bool {
        self.connected && self.login.unwrap_or(true)
    }
}

/// Only packaged bundles on a mounted volume or in the account's Downloads need an offer.
pub fn relocation_source(bundle: &Path, downloads: &Path) -> bool {
    bundle.extension().is_some_and(|ext| ext == "app")
        && (bundle.starts_with("/Volumes") || bundle.starts_with(downloads))
}

/// A verified inventory retains login startup during a manager restart, not after disconnect.
pub fn has_connected_space(result: &serde_json::Value) -> Option<bool> {
    if let Some(connected) = account_connected(result) { return Some(connected); }
    let managers = result.get("managers")?.as_array()?;
    Some(managers.iter().any(|manager| {
        matches!(manager.get("state").and_then(|v| v.as_str()),
            Some("starting" | "answering" | "restarting" | "refused"))
    }))
}

fn account_connected(result: &serde_json::Value) -> Option<bool> {
    let account = result.get("account")?;
    if account["hostSupport"] != "supported" { return None; }
    Some(account["mode"] == "account" && account["lastRegistration"].is_string())
}

/// Describe verified Manager inventory without treating service-only connectivity as ready.
pub fn tray_status(frame: &serde_json::Value) -> String {
    let base = connection_tray_status(frame);
    if frame["ok"] != true { return base; }
    let Some(rows) = frame["result"]["agents"].as_array() else { return base; };
    if rows.iter().any(|row| row["state"] != "read" || !row["agents"].is_array()) {
        return format!("{base} · Agents unavailable");
    }
    let count = rows.iter().filter_map(|row| row["agents"].as_array())
        .flatten().filter(|agent| agent["state"] == "running").count();
    format!("{base} · {count} {} running", if count == 1 { "agent" } else { "agents" })
}

fn connection_tray_status(frame: &serde_json::Value) -> String {
    if frame["ok"].as_bool() != Some(true) {
        return if frame["error"]["code"] == "NOT_RUNNING" { "Sign in required" } else { "Needs attention" }.into();
    }
    let result = &frame["result"];
    if matches!(result["account"]["mode"].as_str(), Some("signed-out" | "sign-in-required")) {
        return "Sign in required".into();
    }
    if let Some(connected) = account_connected(result) {
        let account = &result["account"];
        if !connected || account["message"].is_string() { return "Needs attention".into(); }
        let rows = account["spaces"].as_array();
        let count = rows.map_or(0, |rows| rows.iter().filter(|row| row["observed"] == "connected").count());
        if rows.is_some_and(|rows| rows.iter().any(|row| row["lastRefusal"].is_string())) {
            return "Needs attention".into();
        }
        if count > 0 { return "Connected".into(); }
        return if rows.is_some_and(|rows| rows.iter().any(|row| row["desired"] == true && row["observed"] != "removed on this computer")) {
            "Starting"
        } else { "Ready" }.into();
    }
    if let Some(managers) = result["managers"].as_array() {
        let ready = managers.iter().filter(|m| m["state"] == "answering"
            && m["instanceId"].is_string()
            && m["connectors"].as_array().is_some_and(|cs| cs.iter().any(|c| c["state"] == "available"))).count();
        let active = managers.iter().filter(|m| m["state"] != "stopped").count();
        if ready != active { return format!("Needs attention · {ready} connected"); }
        return match ready {
            0 => "Sign in required".into(),
            1 => "Connected · 1 space".into(),
            n => format!("Connected · {n} spaces"),
        };
    }
    if result["launchReady"] == true { "Connected".into() } else { "Needs attention".into() }
}

/// Format the current-user Windows `Run` registry value for this executable.
pub fn windows_login_command(executable: &Path) -> String {
    format!("{} --background", executable.display())
}

/// Extract the executable path from a Windows `Run` registry command string.
pub fn windows_run_executable(command: &str) -> Option<&str> {
    let trimmed = command.trim_start();
    if let Some(rest) = trimmed.strip_prefix('"') {
        let end = rest.find('"')?;
        let exe = &rest[..end];
        (!exe.is_empty()).then_some(exe)
    } else if let Some((exe, _)) = trimmed.rsplit_once(" --background") {
        let exe = exe.trim();
        (!exe.is_empty()).then_some(exe)
    } else {
        let exe = trimmed.split_whitespace().next()?;
        (!exe.is_empty()).then_some(exe)
    }
}

/// Match a Windows `Run` registry value to this executable only when both canonical paths match.
pub fn windows_run_matches_executable(command: &str, executable: &Path) -> bool {
    let Some(recorded) = windows_run_executable(command) else { return false; };
    let Ok(recorded_canonical) = std::fs::canonicalize(Path::new(recorded)) else { return false; };
    let Ok(current_canonical) = std::fs::canonicalize(executable) else { return false; };
    recorded_canonical == current_canonical
}

/// Windows Task Manager `StartupApproved\Run` records 12+ bytes where the trailing 8 bytes are zero when enabled.
pub fn windows_startup_approved_enabled(bytes: &[u8]) -> bool {
    bytes.len() < 8 || bytes.iter().rev().take(8).all(|&byte| byte == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_recovers_invalid_preferences_without_overwriting_backups() {
        let directory = std::env::temp_dir().join(format!("cotal-preferences-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("presence.json");
        let (preferences, notice) = load_preferences(&path).unwrap();
        assert!(!preferences.recovered && notice.is_none());
        for (index, bytes) in [
            br#"{"relocationDeclined":false,"pinOffered":false,"closeExplained":false}"#.as_slice(),
            b"{broken".as_slice(),
            br#"{"login":"yes"}"#.as_slice(),
            &[0xff],
        ].into_iter().enumerate() {
            std::fs::write(&path, bytes).unwrap();
            let (preferences, notice) = load_preferences(&path).unwrap();
            assert!(preferences.recovered);
            assert!(!preferences.connected && preferences.login.is_none());
            assert!(!preferences.login_enabled());
            assert!(notice.unwrap().contains("No login setting was changed."));
            assert!(!path.exists());
            assert_eq!(std::fs::read(path.with_extension(format!("json.invalid.{index}"))).unwrap(), bytes);
            let serialized = serde_json::to_vec(&preferences).unwrap();
            assert!(serde_json::from_slice::<Preferences>(&serialized).unwrap().recovered);
        }
        std::fs::write(&path, br#"{"login":false,"connected":true}"#).unwrap();
        let (preferences, notice) = load_preferences(&path).unwrap();
        assert!(!preferences.recovered && notice.is_none());
        assert_eq!(preferences.login, Some(false));
        assert!(path.exists());
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(load_preferences(&path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn tray_counts_only_observed_running_agents() {
        use serde_json::json;
        let frame = |agents| json!({"ok": true, "result": {"managers": [{"state": "answering", "instanceId": "i", "connectors": [{"state": "available"}]}], "agents": agents}});
        assert_eq!(tray_status(&frame(json!([]))), "Connected · 1 space · 0 agents running");
        assert_eq!(tray_status(&frame(json!([{"state":"read","agents":[{"state":"running"},{"state":"exited"}]}]))), "Connected · 1 space · 1 agent running");
        assert_eq!(tray_status(&frame(json!([{"state":"unreadable"}]))), "Connected · 1 space · Agents unavailable");
    }
    #[test]
    fn tray_reports_verified_spaces_and_attention_without_claiming_service_readiness() {
        use serde_json::json;
        let ready = json!({"state":"answering", "instanceId":"instance", "connectors":[{"state":"available"}]});
        assert_eq!(tray_status(&json!({"ok":true,"result":{"managers":[]}})), "Sign in required");
        assert_eq!(tray_status(&json!({"ok":true,"result":{"managers":[ready.clone()]}})), "Connected · 1 space");
        assert_eq!(tray_status(&json!({"ok":true,"result":{"managers":[ready.clone(),ready.clone()]}})), "Connected · 2 spaces");
        assert_eq!(tray_status(&json!({"ok":true,"result":{"managers":[ready,{"state":"refused"}]}})), "Needs attention · 1 connected");
        assert_eq!(tray_status(&json!({"ok":false,"error":{"code":"NOT_RUNNING"}})), "Sign in required");
        assert_eq!(tray_status(&json!({"ok":false,"error":{"code":"NOT_ANSWERING"}})), "Needs attention");
        assert_eq!(tray_status(&json!({"ok":true,"result":{"state":"connected"}})), "Needs attention");
    }
    #[test]
    fn registered_account_keeps_login_and_tray_connected_without_assigned_spaces() {
        use serde_json::json;
        let mut result = json!({"managers":[],"account":{"mode":"account","hostSupport":"supported","lastRegistration":"2026-11-11T00:00:00Z","spaces":[]}});
        assert_eq!(has_connected_space(&result), Some(true));
        assert_eq!(tray_status(&json!({"ok":true,"result":result.clone()})), "Ready");
        result["account"]["spaces"] = json!([{"desired":true,"observed":"starting"}]);
        assert_eq!(tray_status(&json!({"ok":true,"result":result.clone()})), "Starting");
        result["account"]["spaces"] = json!([{"desired":true,"observed":"connected"}]);
        assert_eq!(tray_status(&json!({"ok":true,"result":result.clone()})), "Connected");
        result["account"]["spaces"] = json!([{"desired":true,"observed":"removed on this computer"}]);
        assert_eq!(tray_status(&json!({"ok":true,"result":result.clone()})), "Ready");
        result["account"]["mode"] = json!("sign-in-required");
        assert_eq!(has_connected_space(&result), Some(false));
        assert_eq!(tray_status(&json!({"ok":true,"result":result.clone()})), "Sign in required");
        result["account"] = json!({"mode":"signed-out","hostSupport":"unknown","spaces":[]});
        assert_eq!(tray_status(&json!({"ok":true,"result":result})), "Sign in required");
    }
    #[test]
    fn login_defaults_only_when_connected_and_opt_out_survives_reconnect() {
        let mut p = Preferences::default();
        assert!(!p.login_enabled());
        p.connected = true;
        assert!(p.login_enabled());
        p.login = Some(false);
        assert!(!p.login_enabled());
        p.connected = false;
        assert!(!p.login_enabled());
        p.connected = true;
        assert!(!p.login_enabled());
        p.login = Some(true);
        assert!(p.login_enabled());
    }
    #[test]
    fn inventory_does_not_confuse_restart_or_selected_space_with_disconnect() {
        use serde_json::json;
        assert_eq!(has_connected_space(&json!({})), None);
        assert_eq!(has_connected_space(&json!({"managers": []})), Some(false));
        assert_eq!(has_connected_space(&json!({"managers": [{"state":"stopped"}]})), Some(false));
        for state in ["starting", "answering", "restarting", "refused"] {
            assert_eq!(has_connected_space(&json!({"managers": [{"state":"stopped"}, {"state": state}]})), Some(true));
        }
    }
    #[test]
    fn relocation_is_restricted_to_transient_packaged_apps() {
        let downloads = Path::new("/Users/a/Downloads");
        for source in ["/Volumes/Cotal/Cotal.app", "/Users/a/Downloads/Cotal.app"] {
            assert!(relocation_source(Path::new(source), downloads));
        }
        for source in ["/Applications/Cotal.app", "/Users/a/Downloads-foreign/Cotal.app", "/Volumes/Cotal/cotal", "/Users/a/Applications/Cotal.app"] {
            assert!(!relocation_source(Path::new(source), downloads));
        }
    }
    #[test]
    fn windows_run_value_matches_only_canonical_current_executable() {
        let dir = std::env::temp_dir().join(format!("cotal-presence-test-{}", std::process::id()));
        let sub = dir.join("nested");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&sub).unwrap();
        let exe = sub.join("cotal-desktop.exe");
        let other = sub.join("other-app.exe");
        std::fs::write(&exe, b"exe").unwrap();
        std::fs::write(&other, b"other").unwrap();
        assert_eq!(
            windows_login_command(&exe),
            format!("{} --background", exe.display())
        );
        let alt_path = sub.join("..").join("nested").join("cotal-desktop.exe");
        for value in [
            format!("{} --background", exe.display()),
            format!("\"{}\" --background", exe.display()),
            format!("\"{}\" --background", alt_path.display()),
        ] {
            assert!(windows_run_matches_executable(&value, &exe), "{value}");
        }
        for foreign in [
            format!("{} --background", other.display()),
            format!("\"{}\" --background", sub.join("missing.exe").display()),
            String::new(),
        ] {
            assert!(!windows_run_matches_executable(&foreign, &exe), "{foreign}");
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(windows_startup_approved_enabled(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        assert!(!windows_startup_approved_enabled(&[3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]));
    }
}
