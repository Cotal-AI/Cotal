use serde::{Deserialize, Serialize};
use std::path::Path;

pub const APP_ID: &str = "ai.cotal.desktop";

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Preferences {
    pub login: Option<bool>,
    pub connected: bool,
    pub relocation_declined: bool,
    pub pin_offered: bool,
    pub close_explained: bool,
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
    let managers = result.get("managers")?.as_array()?;
    Some(managers.iter().any(|manager| {
        matches!(manager.get("state").and_then(|v| v.as_str()),
            Some("starting" | "answering" | "restarting" | "refused"))
    }))
}

/// Describe verified Manager inventory without treating service-only connectivity as ready.
pub fn tray_status(frame: &serde_json::Value) -> String {
    if frame["ok"].as_bool() != Some(true) {
        return if frame["error"]["code"] == "NOT_RUNNING" { "Not connected" } else { "Needs attention" }.into();
    }
    let result = &frame["result"];
    if let Some(managers) = result["managers"].as_array() {
        let ready = managers.iter().filter(|m| m["state"] == "answering"
            && m["instanceId"].is_string()
            && m["connectors"].as_array().is_some_and(|cs| cs.iter().any(|c| c["state"] == "available"))).count();
        let active = managers.iter().filter(|m| m["state"] != "stopped").count();
        if ready != active { return format!("Needs attention · {ready} connected"); }
        return match ready {
            0 => "Not connected".into(),
            1 => "Connected · 1 space".into(),
            n => format!("Connected · {n} spaces"),
        };
    }
    if result["launchReady"] == true { "Connected".into() } else { "Needs attention".into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tray_reports_verified_spaces_and_attention_without_claiming_service_readiness() {
        use serde_json::json;
        let ready = json!({"state":"answering", "instanceId":"instance", "connectors":[{"state":"available"}]});
        assert_eq!(tray_status(&json!({"ok":true,"result":{"managers":[]}})), "Not connected");
        assert_eq!(tray_status(&json!({"ok":true,"result":{"managers":[ready.clone()]}})), "Connected · 1 space");
        assert_eq!(tray_status(&json!({"ok":true,"result":{"managers":[ready.clone(),ready.clone()]}})), "Connected · 2 spaces");
        assert_eq!(tray_status(&json!({"ok":true,"result":{"managers":[ready,{"state":"refused"}]}})), "Needs attention · 1 connected");
        assert_eq!(tray_status(&json!({"ok":false,"error":{"code":"NOT_RUNNING"}})), "Not connected");
        assert_eq!(tray_status(&json!({"ok":false,"error":{"code":"NOT_ANSWERING"}})), "Needs attention");
        assert_eq!(tray_status(&json!({"ok":true,"result":{"state":"connected"}})), "Needs attention");
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
}
