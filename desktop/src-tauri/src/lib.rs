use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

#[cfg(feature = "desktop")]
pub mod app;

/// The bundled Node executable name, without the platform extension.
pub const NODE_SIDECAR: &str = if cfg!(windows) { "node" } else { "cotal-node" };

/// This is a closed operation list, never a command line supplied by the webview.
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum DesktopRequest {
    #[serde(rename = "about")]
    About {},
    #[serde(rename = "status")]
    Status {},
    #[serde(rename = "install")]
    Install {},
    #[serde(rename = "spaces")]
    Spaces {
        #[serde(skip_serializing_if = "Option::is_none")]
        refresh: Option<bool>,
    },
    #[serde(rename = "login")]
    Login { idp: String },
    #[serde(rename = "setup")]
    Setup { space: String, idp: String },
    #[serde(rename = "space-intent")]
    SpaceIntent { space: String, enabled: bool },
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
}

impl DesktopRequest {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Login { idp } | Self::Setup { idp, .. } => {
                let u = browser_url(idp)?;
                if u.query().is_some() || u.fragment().is_some() {
                    return Err("A provider URL cannot contain a query or fragment.".into());
                }
            }
            Self::SpaceIntent { space, .. }
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
        Ok(())
    }

    pub fn timeout_seconds(&self) -> u64 {
        if matches!(self, Self::Login { .. } | Self::Setup { .. }) {
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
    fn only_closed_requests_are_admitted() {
        assert!(serde_json::from_str::<DesktopRequest>(r#"{"op":"status"}"#).is_ok());
        for input in [
            r#"{"op":"exec","command":"sh"}"#,
            r#"{"op":"status","args":[]}"#,
            r#"{"op":"install","path":"/tmp/foreign"}"#,
            r#"{"op":"setup","space":"team","idp":"https://example.com","PATH":"/foreign"}"#,
            r#"{"op":"setup","space":"team","idp":"https://example.com","command":"sh"}"#,
        ] {
            assert!(serde_json::from_str::<DesktopRequest>(input).is_err());
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
