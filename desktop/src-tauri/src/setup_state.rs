use std::path::Path;

pub fn interrupted(install: &Path) -> Result<bool, String> {
    #[cfg(not(windows))]
    { let _ = install; Ok(false) }
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").ok_or("The Windows application data directory is unavailable.")?;
        let file = std::path::PathBuf::from(local).join("CotalSetup/service-update.json");
        let bytes = match std::fs::read(file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("Setup handover could not be read. Run the installer again.".into()),
        };
        if bytes.len() > 8192 { return Err("Setup handover is oversized. Run the installer again.".into()); }
        let state: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Setup handover is invalid. Run the installer again.")?;
        let path = state["installPath"].as_str().ok_or("Setup handover has no installation path.")?;
        if state["schema"] != 1 { return Err("Setup handover version is unsupported. Run the installer again.".into()); }
        Ok(path.eq_ignore_ascii_case(&install.to_string_lossy()) && state["phase"] != "ready")
    }
}
