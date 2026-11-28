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

/// A packaged app on a disk image, in App Translocation, or in the account's Downloads.
pub fn relocation_source(bundle: &Path, downloads: &Path) -> bool {
    bundle.extension().is_some_and(|ext| ext == "app")
        && (bundle.starts_with("/Volumes")
            || bundle.starts_with(downloads)
            || bundle.components().any(|component| component.as_os_str() == "AppTranslocation"))
}

/// The moved copy is reopened with this exact argument so setup can continue.
pub fn launched_relocated<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == "--relocated")
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

pub fn tray_word(label: &str) -> &str {
    match label {
        "Connected" | "Starting" | "Offline" | "Can't connect" | "Sign in required" | "Service stopped" | "Updating" | "Not set up" | "Disk full" | "Repair needed" => label,
        _ => "Starting",
    }
}

pub fn tray_menu(label: &str, agents: &str) -> String {
    let word = tray_word(label);
    if agents.is_empty() { word.into() } else { format!("{word} · {agents}") }
}

pub fn agent_count(frame: &serde_json::Value) -> String {
    if frame["ok"] != true { return String::new(); }
    let Some(rows) = frame["result"]["agents"].as_array() else { return String::new(); };
    if rows.iter().any(|row| row["state"] != "read" || !row["agents"].is_array()) {
        return "Agents unavailable".into();
    }
    let count = rows.iter().filter_map(|row| row["agents"].as_array())
        .flatten().filter(|agent| agent["state"] == "running").count();
    format!("{count} {} running", if count == 1 { "agent" } else { "agents" })
}

/// Quote the executable path in a Windows `Run` command.
#[cfg(any(windows, test))]
pub fn windows_login_command(executable: &Path) -> String {
    format!("\"{}\" --background", executable.display())
}

/// Match both the previous unquoted command and the current quoted command.
#[cfg(any(windows, test))]
pub fn windows_run_matches_executable(command: &str, executable: &Path) -> bool {
    let Some(path) = command.trim().strip_suffix(" --background") else { return false; };
    let path = path.strip_prefix('"').and_then(|path| path.strip_suffix('"')).unwrap_or(path);
    let path = Path::new(path);
    if !path.is_absolute() { return false; }
    let Ok(recorded) = std::fs::canonicalize(path) else { return false; };
    let Ok(current) = std::fs::canonicalize(executable) else { return false; };
    recorded == current
}

/// The startup approval record ends in eight zero bytes when enabled.
#[cfg(any(windows, test))]
pub fn windows_startup_approved_enabled(bytes: &[u8]) -> bool {
    bytes.len() < 8 || bytes.iter().rev().take(8).all(|&byte| byte == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_login_scope_matches_only_the_installed_executable() {
        let dir = std::env::temp_dir().join(format!("cotal login scope {}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let exe = dir.join("cotal-desktop.exe");
        let other = dir.join("another-cotal.exe");
        std::fs::write(&exe, b"exe").unwrap();
        std::fs::write(&other, b"other").unwrap();
        let quoted = windows_login_command(&exe);
        assert_eq!(quoted, format!("\"{}\" --background", exe.display()));
        assert!(windows_run_matches_executable(&quoted, &exe));
        assert!(windows_run_matches_executable(&format!("{} --background", exe.display()), &exe));
        assert!(!windows_run_matches_executable(&windows_login_command(&other), &exe));
        assert!(!windows_run_matches_executable("cotal-desktop.exe --background", &exe));
        assert!(!windows_run_matches_executable(&format!("\"{}\" --other", exe.display()), &exe));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(windows_startup_approved_enabled(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        assert!(!windows_startup_approved_enabled(&[3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]));
    }
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
        let frame = |agents| json!({"ok": true, "result": {"agents": agents}});
        assert_eq!(tray_menu("Connected", &agent_count(&frame(json!([])))), "Connected · 0 agents running");
        assert_eq!(tray_menu("Connected", &agent_count(&frame(json!([{"state":"read","agents":[{"state":"running"},{"state":"exited"}]}])))), "Connected · 1 agent running");
        assert_eq!(tray_menu("Connected", &agent_count(&frame(json!([{"state":"unreadable"}])))), "Connected · Agents unavailable");
    }
    #[test]
    fn tray_uses_the_window_word_even_when_the_poll_fails() {
        let failed = serde_json::json!({"ok":false,"error":{"code":"NOT_RUNNING"}});
        for word in ["Connected", "Starting", "Offline", "Can't connect", "Sign in required", "Service stopped", "Updating", "Not set up", "Disk full", "Repair needed"] {
            assert_eq!(tray_word(word), word);
            assert_eq!(tray_menu(word, &agent_count(&failed)), word);
            assert_eq!(tray_menu(word, "1 agent running"), format!("{word} · 1 agent running"));
        }
        assert_eq!(tray_menu("Needs attention", ""), "Starting");
        assert_eq!(tray_menu("", ""), "Starting");
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
        for source in [
            "/Volumes/Cotal/Cotal.app",
            "/Users/a/Downloads/Cotal.app",
            "/private/var/folders/ab/xyz/T/AppTranslocation/C0FFEE/d/Cotal.app",
        ] {
            assert!(relocation_source(Path::new(source), downloads));
        }
        assert!(launched_relocated(["--background", "--relocated"]));
        assert!(!launched_relocated(["--background", "--relocated-later"]));
        assert!(!launched_relocated(std::iter::empty::<&str>()));
        for source in ["/Applications/Cotal.app", "/Users/a/Downloads-foreign/Cotal.app", "/Volumes/Cotal/cotal", "/Users/a/Applications/Cotal.app"] {
            assert!(!relocation_source(Path::new(source), downloads));
        }
    }
}
