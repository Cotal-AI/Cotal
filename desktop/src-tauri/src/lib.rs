use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

#[cfg(feature = "desktop")]
pub mod app;
#[cfg(feature = "desktop")]
mod native_presence;
#[cfg(feature = "desktop")]
pub mod updater;
pub mod app_activity;
#[cfg(any(feature = "desktop", test))]
mod terminal;
pub mod update_receipt;
pub mod presence;
pub mod first_paint;
pub mod setup_state;

/// The bundled Node executable name, without the platform extension.
pub const NODE_SIDECAR: &str = if cfg!(windows) { "node" } else { "cotal-node" };

/// This is a closed operation list, never a command line supplied by the webview.
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum DesktopRequest {
    #[serde(rename = "update-policy")]
    UpdatePolicy {
        #[serde(skip_serializing_if = "Option::is_none")]
        auto: Option<bool>,
    },
    #[serde(rename = "update-check")]
    UpdateCheck {},
    #[serde(rename = "update-release")]
    UpdateRelease { version: String },
    #[serde(rename = "update-settings")]
    UpdateSettings {
        #[serde(skip_serializing_if = "Option::is_none")]
        auto: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        notify: Option<bool>,
    },
    #[serde(rename = "about")]
    About {},
    #[serde(rename = "status")]
    Status {},
    #[serde(rename = "status-watch")]
    StatusWatch {},
    #[serde(rename = "log")]
    Log {},
    #[serde(rename = "install")]
    Install {},
    #[serde(rename = "start")]
    Start {},
    #[serde(rename = "name")]
    Name {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    #[serde(rename = "spaces")]
    Spaces {
        #[serde(skip_serializing_if = "Option::is_none")]
        refresh: Option<bool>,
    },
    #[serde(rename = "login")]
    Login { idp: String },
    #[serde(rename = "logout")]
    Logout { idp: String },
    #[serde(rename = "setup")]
    Setup { space: String, idp: String },
    #[serde(rename = "space-recover")]
    SpaceRecover { space: String, candidate: String, holder: String },
    #[serde(rename = "space-intent")]
    SpaceIntent { space: String, enabled: bool },
    #[serde(rename = "agent-stop", rename_all = "camelCase")]
    AgentStop { space: String, lifecycle_uid: String },
    #[serde(rename = "agent-terminal", rename_all = "camelCase")]
    AgentTerminal { space: String, lifecycle_uid: String },
    #[serde(rename = "connect-check")]
    ConnectCheck { space: String },
    #[serde(rename = "register")]
    Register { space: String },
    #[serde(rename = "service-connect")]
    Connect { space: String },
    #[serde(rename = "service-disconnect")]
    Disconnect { space: String },
    #[serde(rename = "service-status")]
    ServiceStatus { space: String },
    #[serde(rename = "agent-apps")]
    AgentApps {
        #[serde(skip_serializing_if = "Option::is_none")]
        refresh: Option<bool>,
    },
    #[serde(rename = "agent-app-install")]
    AgentAppInstall { name: String },
    #[serde(rename = "agent-app-sign-in")]
    AgentAppSignIn { name: String },
    #[serde(rename = "repair-plan")]
    RepairPlan {},
    #[serde(rename = "repair-apply")]
    RepairApply { digest: String, consent: Vec<String> },
}

impl DesktopRequest {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::SpaceRecover { space, candidate, holder } => {
                Self::ConnectCheck { space: space.clone() }.validate()?;
                if candidate.len() != 64 || !candidate.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) || holder.len() > 2048 {
                    return Err("Invalid custody recovery.".into());
                }
                browser_url(holder)?;
            }
            Self::UpdateRelease { version } => {
                let parts: Vec<_> = version.split('.').collect();
                if parts.len() != 3 || parts.iter().any(|part| part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit())) || version.len() > 64 {
                    return Err("Invalid release version.".into());
                }
            }
            Self::Login { idp } | Self::Logout { idp } | Self::Setup { idp, .. } => {
                let u = browser_url(idp)?;
                if u.query().is_some() || u.fragment().is_some() {
                    return Err("A provider URL cannot contain a query or fragment.".into());
                }
            }
            Self::SpaceIntent { space, .. }
            | Self::AgentStop { space, .. }
            | Self::AgentTerminal { space, .. }
            | Self::ConnectCheck { space }
            | Self::Register { space }
            | Self::Connect { space }
            | Self::Disconnect { space }
            | Self::ServiceStatus { space } => {
                if space.is_empty()
                    || space.len() > 64
                    || !space
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                {
                    return Err("Invalid space name.".into());
                }
            }
            _ => {}
        }
        if let Self::Setup { space, .. } = self {
            Self::ConnectCheck { space: space.clone() }.validate()?;
        }
        // The webview names an installed connector's application and nothing else; the service
        // reads every command from that connector's declaration.
        if let Self::AgentAppInstall { name } | Self::AgentAppSignIn { name } = self {
            let bytes = name.as_bytes();
            if bytes.is_empty()
                || bytes.len() > 64
                || !bytes[0].is_ascii_alphanumeric()
                || !bytes.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
            {
                return Err("Invalid application name.".into());
            }
        }
        if let Self::RepairApply { digest, consent } = self {
            if digest.len() != 64
                || !digest.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                || consent.len() > 3
                || !consent.iter().all(|item| item == "takeover" || item == "start-stopped" || item == "remove-old-registration")
            {
                return Err("Invalid repair approval.".into());
            }
        }
        Ok(())
    }

    pub fn is_watch(&self) -> bool {
        matches!(self, Self::StatusWatch {})
    }

    pub fn timeout_seconds(&self) -> u64 {
        // An installer may run for 15 minutes and a browser sign-in for 10; the service stops either first.
        if matches!(self, Self::Login { .. } | Self::Setup { .. } | Self::AgentAppInstall { .. } | Self::AgentAppSignIn { .. } | Self::RepairApply { .. }) {
            1200
        } else {
            150
        }
    }
}

/// Only web URLs reach the operating-system opener. Never file, custom protocol or credentials.
pub fn browser_url(value: &str) -> Result<Url, String> {
    if value.len() > 4096 {
        return Err("The browser URL is too long.".into());
    }
    let u = Url::parse(value).map_err(|_| "Invalid browser URL.".to_string())?;
    let loopback = matches!(u.host(), Some(Host::Ipv4(ip)) if ip == Ipv4Addr::LOCALHOST)
        || matches!(u.host(), Some(Host::Ipv6(ip)) if ip == Ipv6Addr::LOCALHOST);
    if !u.username().is_empty()
        || u.password().is_some()
        || u.host().is_none()
        || !(u.scheme() == "https" || (u.scheme() == "http" && loopback))
    {
        return Err(
            "Use an HTTPS page or a literal loopback HTTP address, without credentials.".into(),
        );
    }
    Ok(u)
}

/// The stock daemon receives OS integration variables, never a terminal's agent/provider secrets.
pub fn daemon_env_key(key: &str) -> bool {
    matches!(
        key.to_ascii_uppercase().as_str(),
        "PATH"
            | "HOME"
            | "USER"
            | "LOGNAME"
            | "LANG"
            | "LANGUAGE"
            | "LC_ALL"
            | "LC_CTYPE"
            | "XDG_RUNTIME_DIR"
            | "XDG_CONFIG_HOME"
            | "XDG_DATA_HOME"
            | "XDG_CACHE_HOME"
            | "XDG_STATE_HOME"
            | "DBUS_SESSION_BUS_ADDRESS"
            | "DISPLAY"
            | "WAYLAND_DISPLAY"
            | "SYSTEMROOT"
            | "WINDIR"
            | "USERPROFILE"
            | "LOCALAPPDATA"
            | "APPDATA"
            | "TEMP"
            | "TMP"
            | "COMSPEC"
            | "PATHEXT"
            | "NUMBER_OF_PROCESSORS"
            | "PROCESSOR_ARCHITECTURE"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_sidecar_matches_bundle_configuration() {
        let config: serde_json::Value = serde_json::from_str(if cfg!(windows) {
            include_str!("../tauri.windows.conf.json")
        } else {
            include_str!("../tauri.conf.json")
        })
        .unwrap();
        assert_eq!(
            config["bundle"]["externalBin"],
            serde_json::json!([format!("binaries/{NODE_SIDECAR}")])
        );
    }
    #[test]
    fn custody_recovery_validates_the_candidate_and_holder() {
        for (candidate, holder, valid) in [
            ("b".repeat(64), "https://example.test/api/auth", true),
            ("B".repeat(64), "https://example.test/api/auth", false),
            ("b".repeat(64), "file:///tmp/auth", false),
        ] {
            assert_eq!(DesktopRequest::SpaceRecover { space: "team".into(), candidate, holder: holder.into() }.validate().is_ok(), valid);
        }
    }
    #[test]
    fn only_closed_requests_are_admitted() {
        let status = serde_json::from_str::<DesktopRequest>(r#"{"op":"status"}"#).unwrap();
        assert!(!status.is_watch());
        let watch = serde_json::from_str::<DesktopRequest>(r#"{"op":"status-watch"}"#).unwrap();
        assert!(watch.is_watch());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"log"}"#).is_ok());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"log","path":"/foreign"}"#).is_err());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"log","limit":1000000}"#).is_err());
        assert!(DesktopRequest::Log {}.validate().is_ok());
        let start = serde_json::from_str::<DesktopRequest>(r#"{"op":"start"}"#).unwrap();
        assert!(start.validate().is_ok());
        assert_eq!(serde_json::to_value(start).unwrap(), serde_json::json!({"op": "start"}));
        for input in [
            // Only the uninstaller removes the background service; the window can never ask for it.
            r#"{"op":"remove-service"}"#,
            r#"{"op":"exec","command":"sh"}"#,
            r#"{"op":"status","args":[]}"#,
            r#"{"op":"status-watch","args":[]}"#,
            r#"{"op":"install","path":"/tmp/foreign"}"#,
            r#"{"op":"start","path":"/tmp/foreign"}"#,
            r#"{"op":"setup","space":"team","idp":"https://example.com","PATH":"/foreign"}"#,
            r#"{"op":"setup","space":"team","idp":"https://example.com","command":"sh"}"#,
            r#"{"op":"agent-app-install","name":"claude","script":"https://example.com/x.sh"}"#,
            r#"{"op":"agent-app-install"}"#,
            r#"{"op":"agent-app-sign-in","name":"claude","args":["auth","login"]}"#,
            r#"{"op":"agent-apps","path":"/foreign"}"#,
        ] {
            assert!(serde_json::from_str::<DesktopRequest>(input).is_err());
        }
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"agent-apps"}"#).unwrap().validate().is_ok());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"repair-plan"}"#).unwrap().validate().is_ok());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"repair-plan","path":"/foreign"}"#).is_err());
        let digest = "a".repeat(64);
        for (consent, valid) in [(vec![], true), (vec!["takeover"], true), (vec!["takeover", "start-stopped"], true), (vec!["remove-old-registration"], true), (vec!["uninstall"], false), (vec!["takeover"; 4], false)] {
            let request = DesktopRequest::RepairApply { digest: digest.clone(), consent: consent.iter().map(|item| item.to_string()).collect() };
            assert_eq!(request.validate().is_ok(), valid, "{consent:?}");
        }
        assert!(DesktopRequest::RepairApply { digest: "A".repeat(64), consent: vec![] }.validate().is_err());
        assert!(DesktopRequest::RepairApply { digest: "a".repeat(63), consent: vec![] }.validate().is_err());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"agent-apps","refresh":true}"#).unwrap().validate().is_ok());
        for (name, valid) in [("claude", true), ("connector-2", true), ("", false), ("-x", false), ("Claude", false), ("a b", false), ("../x", false), (&"a".repeat(65)[..], false)] {
            assert_eq!(DesktopRequest::AgentAppInstall { name: name.into() }.validate().is_ok(), valid, "{name}");
            assert_eq!(DesktopRequest::AgentAppSignIn { name: name.into() }.validate().is_ok(), valid, "{name}");
        }
        for (space, idp, valid) in [
            ("team", "https://example.com/api/auth", true),
            ("a b", "https://example.com", false),
            ("team", "file:///tmp/auth", false),
            ("team", "https://example.com?token=x", false),
        ] {
            assert_eq!(DesktopRequest::Setup { space: space.into(), idp: idp.into() }.validate().is_ok(), valid);
        }
        assert!(DesktopRequest::Connect {
            space: "--help".into()
        }
        .validate()
        .is_ok());
        assert!(DesktopRequest::Connect {
            space: "a b".into()
        }
        .validate()
        .is_err());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"update-policy"}"#).is_ok());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"update-policy","auto":false}"#).is_ok());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"update-policy","auto":"off"}"#).is_err());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"update-policy","path":"/foreign"}"#).is_err());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"update-settings","auto":false,"notify":true}"#).is_ok());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"update-settings","notify":"on"}"#).is_err());
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"update-check","force":true}"#).is_err());
        assert!(DesktopRequest::UpdateRelease { version: "0.160.5".into() }.validate().is_ok());
        assert!(DesktopRequest::UpdateRelease { version: "../latest".into() }.validate().is_err());
        // Names are stdin JSON values, never concatenated into argv or interpreted by a shell.
    }
    #[test]
    fn browser_refuses_non_web_and_credential_urls() {
        for input in [
            "file:///tmp/key",
            "javascript:alert(1)",
            "https://u:p@example.com",
            "http://example.com",
            "http://127.0.0.1.example.com",
        ] {
            assert!(browser_url(input).is_err());
        }
        for input in [
            "https://example.com/approve?code=ABC",
            "http://127.0.0.1:8080/approve",
            "http://[::1]:8080/approve",
        ] {
            assert!(browser_url(input).is_ok());
        }
    }
    #[test]
    fn inherited_provider_and_mesh_authority_are_not_forwarded() {
        for key in [
            "COTAL_TOKEN",
            "COTAL_SPACE",
            "COTAL_MANAGED_HANDOFF_FILE",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "NODE_OPTIONS",
            "NODE_PATH",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
        ] {
            assert!(!daemon_env_key(key));
        }
        for key in [
            "HOME",
            "PATH",
            "XDG_RUNTIME_DIR",
            "SystemRoot",
            "LOCALAPPDATA",
        ] {
            assert!(daemon_env_key(key));
        }
    }
}
