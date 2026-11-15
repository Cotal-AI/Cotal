use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::Path, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};

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
    #[serde(default)]
    pub failed_version: Option<String>,
}
fn unique() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("{}-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed))
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

/// Reconciles an out-of-process Windows NSIS setup result with the pending session receipt.
pub fn reconcile_setup(mut receipt: Receipt, app_version: &str, setup_result: Result<Option<&serde_json::Value>, &str>) -> (Receipt, Option<String>) {
    if receipt.phase != "installing" { return (receipt, None); }
    let result = match setup_result {
        Err(error) => {
            let reason = error.to_string();
            receipt.phase = "failed".into();
            receipt.reason = Some(reason.clone());
            return (receipt, Some(reason));
        }
        Ok(Some(result)) if result["schema"].as_u64() == Some(1) && result["toVersion"].as_str() == Some(receipt.target.as_str()) => result,
        Ok(_) => {
            let reason = format!("The installer did not report a result for {}", receipt.target);
            receipt.phase = "failed".into();
            receipt.reason = Some(reason.clone());
            return (receipt, Some(reason));
        }
    };
    let code = result["code"].as_i64().unwrap_or(-1);
    let outcome = result["outcome"].as_str().unwrap_or("");
    let message = result["message"].as_str().unwrap_or("Setup did not complete.").trim();
    if outcome == "updated" && code == 0 && app_version == receipt.target {
        receipt.phase = "installed".into();
        receipt.reason = None;
        return (receipt, None);
    }
    if outcome == "started-unconfirmed" && code == 23 && app_version == receipt.target {
        let reason = format!("Setup code 23: {message}");
        receipt.phase = "installed".into();
        receipt.reason = None;
        return (receipt, Some(reason));
    }
    if outcome == "rolled-back" && code == 23 && app_version == receipt.from {
        let reason = format!("Setup code 23: {message}");
        receipt.phase = "failed".into();
        receipt.reason = Some(reason.clone());
        receipt.failed_version = Some(receipt.target.clone());
        return (receipt, Some(reason));
    }
    if outcome == "rollback-unconfirmed" && code == 23 {
        let reason = format!("Setup code 23: {message}");
        receipt.phase = "failed".into();
        receipt.reason = Some(reason.clone());
        receipt.failed_version = Some(receipt.target.clone());
        return (receipt, Some(reason));
    }
    let reason = format!("Setup code {code}: {message}");
    receipt.phase = "failed".into();
    receipt.reason = Some(reason.clone());
    (receipt, Some(reason))
}

/// Checks the daemon's own status frame for held seats before an automatic Windows update handoff.
/// `status.agents` projects `Manager.hostedAgents()` (`[...this.agents.values()]`), the same `this.agents`
/// map counted by `Manager.hostedSeatCount()` (`this.agents.size`) in `managers-prepare-restart`.
pub fn active_agents_reason(frame: &serde_json::Value) -> Result<Option<String>, String> {
    if frame["ok"].as_bool() == Some(false) {
        if frame["error"]["code"].as_str() == Some("NOT_RUNNING") { return Ok(None); }
        return Err(frame["error"]["message"].as_str().unwrap_or("The background service status could not be read.").to_string());
    }
    if frame["ok"].as_bool() != Some(true) {
        return Err("The background service status is unavailable.".into());
    }
    let rows = frame["result"]["agents"].as_array().ok_or("The background service agent inventory is unavailable.")?;
    let mut names = Vec::new();
    let mut all_running = true;
    for row in rows {
        if row["state"].as_str() != Some("read") {
            return Ok(Some("Automatic update is waiting because running agents could not be verified. Use Restart to update or stop running agents.".into()));
        }
        let agents = row["agents"].as_array().ok_or("The background service agent list is invalid.")?;
        for agent in agents {
            if agent["state"].as_str() != Some("running") { all_running = false; }
            let name = agent["name"].as_str().unwrap_or("").trim();
            names.push(if name.is_empty() { "(unnamed)".to_string() } else { name.to_string() });
        }
    }
    if names.is_empty() {
        Ok(None)
    } else {
        let state = if all_running { "running" } else { "held" };
        Ok(Some(format!("{} agent(s) are {state} ({}). Automatic update will wait until they finish, or choose Restart to update.", names.len(), names.join(", "))))
    }
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
        let receipt = Receipt { schema: 1, from: "0.164.8".into(), target: "0.164.9".into(), phase: "installed".into(), reopen: true, relaunch_pending: true, reason: None, failed_version: None };
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
        let mut receipt = Receipt { schema: 1, from: "0.164.8".into(), target: "0.164.9".into(), phase: "failed".into(), reopen: false, relaunch_pending: false, reason: Some("test".into()), failed_version: None };
        write(&path, &receipt).unwrap(); clear_failed(&path).unwrap(); assert!(!path.exists());
        receipt.phase = "installed".into(); write(&path, &receipt).unwrap(); clear_failed(&path).unwrap(); assert!(path.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn windows_setup_result_reconciles_installed_and_refused_receipts() {
        let base = Receipt { schema: 1, from: "0.164.8".into(), target: "0.164.9".into(), phase: "installing".into(), reopen: false, relaunch_pending: true, reason: None, failed_version: None };
        let updated = serde_json::json!({"schema":1,"outcome":"updated","code":0,"message":"Cotal 0.164.9 is installed and its background service is running.","toVersion":"0.164.9"});
        let (installed, reason) = reconcile_setup(base.clone(), "0.164.9", Ok(Some(&updated)));
        assert_eq!(installed.phase, "installed");
        assert!(installed.reason.is_none());
        assert!(reason.is_none());
        let unconfirmed = serde_json::json!({"schema":1,"outcome":"started-unconfirmed","code":23,"message":"Cotal 0.164.9 is installed and service startup was requested, but readiness was not confirmed within 60 seconds. Check cotal daemon status.","toVersion":"0.164.9"});
        let (code23, reason) = reconcile_setup(base.clone(), "0.164.9", Ok(Some(&unconfirmed)));
        assert_eq!(code23.phase, "installed");
        assert!(code23.reason.is_none());
        assert_eq!(reason.as_deref(), Some("Setup code 23: Cotal 0.164.9 is installed and service startup was requested, but readiness was not confirmed within 60 seconds. Check cotal daemon status."));
        let occupied = serde_json::json!({"schema":1,"outcome":"refused","code":20,"message":"1 agent(s) are running. Stop them and choose Retry.","toVersion":"0.164.9"});
        let (refused, reason) = reconcile_setup(base.clone(), "0.164.8", Ok(Some(&occupied)));
        assert_eq!(refused.phase, "failed");
        assert!(refused.relaunch_pending);
        assert!(!refused.reopen);
        assert_eq!(reason.as_deref(), Some("Setup code 20: 1 agent(s) are running. Stop them and choose Retry."));
        assert_eq!(refused.reason, reason);
        let (missing_on_target, reason) = reconcile_setup(base.clone(), "0.164.9", Ok(None));
        assert_eq!(missing_on_target.phase, "failed");
        assert_eq!(reason.as_deref(), Some("The installer did not report a result for 0.164.9"));
        let wrong_target = serde_json::json!({"schema":1,"outcome":"updated","code":0,"message":"Cotal 0.164.8 is installed.","toVersion":"0.164.8"});
        let (mismatched, reason) = reconcile_setup(base.clone(), "0.164.9", Ok(Some(&wrong_target)));
        assert_eq!(mismatched.phase, "failed");
        assert_eq!(reason.as_deref(), Some("The installer did not report a result for 0.164.9"));
        let (parse_err, reason) = reconcile_setup(base.clone(), "0.164.9", Err("Setup result is invalid JSON: expected value at line 1 column 1"));
        assert_eq!(parse_err.phase, "failed");
        assert_eq!(reason.as_deref(), Some("Setup result is invalid JSON: expected value at line 1 column 1"));
        let rolled = serde_json::json!({"schema":1,"outcome":"rolled-back","code":23,"message":"Cotal 0.164.9 did not start its background service. Cotal 0.164.8 is running again.","fromVersion":"0.164.8","toVersion":"0.164.9"});
        let (rolled_back, reason) = reconcile_setup(base.clone(), "0.164.8", Ok(Some(&rolled)));
        assert_eq!(rolled_back.phase, "failed");
        assert_eq!(rolled_back.failed_version.as_deref(), Some("0.164.9"));
        assert_eq!(reason.as_deref(), Some("Setup code 23: Cotal 0.164.9 did not start its background service. Cotal 0.164.8 is running again."));
        let rollback_unconfirmed = serde_json::json!({"schema":1,"outcome":"rollback-unconfirmed","code":23,"message":"Cotal 0.164.8 could not be confirmed after rolling back 0.164.9. Run the installer again.","toVersion":"0.164.9"});
        let (stopped, reason) = reconcile_setup(base, "0.164.9", Ok(Some(&rollback_unconfirmed)));
        assert_eq!(stopped.phase, "failed");
        assert!(reason.unwrap().contains("could not be confirmed"));
    }
    #[test]
    fn active_agents_reason_blocks_automatic_handoff_when_agents_run_or_are_unreadable() {
        let not_running = serde_json::json!({"ok":false,"error":{"code":"NOT_RUNNING","message":"not running"}});
        assert_eq!(active_agents_reason(&not_running).unwrap(), None);
        let idle = serde_json::json!({"ok":true,"result":{"agents":[{"space":"team","state":"read","agents":[]}]}});
        assert_eq!(active_agents_reason(&idle).unwrap(), None);
        let exited_still_held = serde_json::json!({"ok":true,"result":{"agents":[{"space":"team","state":"read","agents":[{"name":"held_seat","state":"exited"}]}]}});
        assert_eq!(active_agents_reason(&exited_still_held).unwrap().as_deref(), Some("1 agent(s) are held (held_seat). Automatic update will wait until they finish, or choose Restart to update."));
        let busy = serde_json::json!({"ok":true,"result":{"agents":[{"space":"team","state":"read","agents":[{"name":"upgrade_fixture","state":"running"}]}]}});
        assert_eq!(active_agents_reason(&busy).unwrap().as_deref(), Some("1 agent(s) are running (upgrade_fixture). Automatic update will wait until they finish, or choose Restart to update."));
        let unreadable = serde_json::json!({"ok":true,"result":{"agents":[{"space":"team","state":"unreadable"}]}});
        assert_eq!(active_agents_reason(&unreadable).unwrap().as_deref(), Some("Automatic update is waiting because running agents could not be verified. Use Restart to update or stop running agents."));
    }
}
