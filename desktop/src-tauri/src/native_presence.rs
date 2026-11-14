use crate::presence::{has_connected_space, Preferences};
use serde::Serialize;
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

pub struct Presence(pub Mutex<Preferences>);

fn preference_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("presence.json"))
}

pub fn load(app: &AppHandle) -> Result<Preferences, String> {
    match fs::read(preference_path(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Desktop preferences are invalid. No login setting was changed.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save(app: &AppHandle, preferences: &Preferences) -> Result<(), String> {
    let path = preference_path(app)?;
    fs::create_dir_all(path.parent().ok_or("Desktop preference directory is unavailable.")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.new");
    fs::write(&temporary, serde_json::to_vec(preferences).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn bundle() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    executable.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .map(PathBuf::from).ok_or_else(|| "Run the packaged Cotal application to install it.".to_string())
}

fn transient(app: &AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if cfg!(debug_assertions) { return Ok(false); }
        return Ok(crate::presence::relocation_source(&bundle()?, &app.path().download_dir().map_err(|e| e.to_string())?));
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Ok(false) }
}

fn apply_login(app: &AppHandle, preferences: &Preferences) -> Result<(), String> {
    let enabled = preferences.login_enabled() && !transient(app)?;
    if app.autolaunch().is_enabled().map_err(|e| e.to_string())? != enabled {
        if enabled { app.autolaunch().enable() } else { app.autolaunch().disable() }
            .map_err(|e| format!("Open at login could not be changed: {e}"))?;
    }
    Ok(())
}

/// Only successful replies from the bundled, authenticated daemon update connection intent.
pub fn observe(app: &AppHandle, operation: &str, frame: &serde_json::Value) -> Result<(), String> {
    if frame.get("ok").and_then(|v| v.as_bool()) != Some(true) { return Ok(()); }
    let result = &frame["result"];
    let connected = match operation {
        "status" => has_connected_space(result),
        "setup" if result["launchReady"].as_bool() == Some(true) => Some(true),
        _ => None,
    };
    if let Some(connected) = connected {
        let state = app.state::<Presence>();
        let mut p = state.0.lock().map_err(|_| "Desktop preferences are busy.")?;
        let changed = p.connected != connected;
        p.connected = connected;
        apply_login(app, &p)?;
        if changed { save(app, &p)?; }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceView {
    login_enabled: bool,
    relocation_offer: bool,
    pin_offer: bool,
    pin_message: String,
}

#[tauri::command]
pub async fn desktop_presence(app: AppHandle) -> Result<PresenceView, String> {
    let (connected, pin_offered, relocation_declined) = {
        let state = app.state::<Presence>();
        let p = state.0.lock().map_err(|_| "Desktop preferences are busy.")?;
        (p.connected, p.pin_offered, p.relocation_declined)
    };
    let (pin_offer, pin_message) = if connected && !pin_offered {
        pin_status(&app).await
    } else { (false, String::new()) };
    Ok(PresenceView {
        login_enabled: app.autolaunch().is_enabled().map_err(|e| e.to_string())?,
        relocation_offer: !relocation_declined && transient(&app)?,
        pin_offer,
        pin_message,
    })
}

#[tauri::command]
pub fn set_login_preference(app: AppHandle, enabled: bool) -> Result<(), String> {
    let _activity = app.state::<crate::app_activity::Activity>().request()?;
    let state = app.state::<Presence>();
    let mut p = state.0.lock().map_err(|_| "Desktop preferences are busy.")?;
    if enabled && !p.connected { return Err("Connect this computer before enabling Open at login.".into()); }
    if enabled && transient(&app)? { return Err("Move Cotal to Applications before enabling Open at login.".into()); }
    p.login = Some(enabled);
    apply_login(&app, &p)?;
    save(&app, &p)
}

#[tauri::command]
pub fn dismiss_presence_offer(app: AppHandle, offer: String) -> Result<(), String> {
    let _activity = app.state::<crate::app_activity::Activity>().request()?;
    let state = app.state::<Presence>();
    let mut p = state.0.lock().map_err(|_| "Desktop preferences are busy.")?;
    match offer.as_str() {
        "relocation" => p.relocation_declined = true,
        "pin" => p.pin_offered = true,
        _ => return Err("Unknown desktop offer.".into()),
    }
    save(&app, &p)
}

/// The source is this executable's bundle and the destination is fixed. Existing apps are never replaced.
#[tauri::command]
pub async fn move_to_applications(app: AppHandle) -> Result<(), String> {
    let _activity = app.state::<crate::app_activity::Activity>().request()?;
    #[cfg(target_os = "macos")]
    {
        if !transient(&app)? { return Err("This application is not running from a disk image or Downloads.".into()); }
        let source = bundle()?;
        let destination = PathBuf::from("/Applications/Cotal.app");
        // Reserve the destination exclusively before copying. Never overwrite another installation.
        fs::create_dir(&destination).map_err(|_| "Cotal already exists in Applications, or Applications is not writable. Quit and open the installed app, or move Cotal in Finder.".to_string())?;
        let status = std::process::Command::new("/usr/bin/ditto").arg(&source).arg(&destination).status().map_err(|e| e.to_string())?;
        if !status.success() { return Err("Cotal could not be copied. A partial copy remains in Applications; inspect it in Finder before trying again.".into()); }
        tauri_plugin_single_instance::destroy(&app);
        let status = std::process::Command::new("/usr/bin/open").args(["-n", "/Applications/Cotal.app", "--args", "--relocated"]).status().map_err(|e| e.to_string())?;
        if !status.success() { return Err("Cotal was copied but could not reopen. Open it from Applications.".into()); }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Err("Moving to Applications is available only on macOS.".into()) }
}

pub fn explain_close(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<Presence>();
    let mut p = state.0.lock().map_err(|_| "Desktop preferences are busy.")?;
    if p.close_explained { return Ok(false); }
    p.close_explained = true;
    save(app, &p)?;
    Ok(true)
}

#[cfg(windows)]
fn taskbar_manager() -> Result<windows::UI::Shell::TaskbarManager, String> {
    use windows::{core::w, UI::Shell::{ITaskbarManagerDesktopAppSupportStatics, TaskbarManager}, Win32::System::Registry::*};
    windows::core::factory::<TaskbarManager, ITaskbarManagerDesktopAppSupportStatics>()
        .map_err(|_| "This Windows version does not support desktop taskbar pin requests.".to_string())?;
    let mut required = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE,
        w!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModel\\LimitedAccessFeatures\\com.microsoft.windows.taskbar.pin"),
        w!("4096B239A7295B635C090E647E867B5707DA6AB6CB78340B01FE4E0C8F4953D4"),
        RRF_RT_REG_DWORD, None, Some((&mut required as *mut u32).cast()), Some(&mut size)) };
    // Missing feature metadata means no LAF restriction, per Microsoft's documented probe.
    if status.0 != 0 && status.0 != 2 { return Err("Windows taskbar pin permission could not be checked.".into()); }
    if required != 0 { return Err("This Windows version requires Microsoft's taskbar pin approval token, which Cotal does not have. Use the taskbar's Pin to taskbar menu.".into()); }
    let manager = TaskbarManager::GetDefault().map_err(|e| e.to_string())?;
    if !manager.IsSupported().map_err(|e| e.to_string())? || !manager.IsPinningAllowed().map_err(|e| e.to_string())? {
        return Err("Windows or your administrator does not allow taskbar pin requests.".into());
    }
    Ok(manager)
}

async fn pin_status(app: &AppHandle) -> (bool, String) {
    #[cfg(windows)]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Err(e) = app.run_on_main_thread(move || {
            let operation = taskbar_manager().and_then(|manager| manager.IsCurrentAppPinnedAsync().map_err(|e| e.to_string()));
            let _ = tx.send(operation);
        }) { return (false, format!("Windows could not check taskbar pinning: {e}")); }
        match rx.await {
            Ok(Ok(operation)) => match operation.await {
                    Ok(true) => (false, "Cotal is pinned to your taskbar.".into()),
                    Ok(false) => (true, String::new()),
                    Err(e) => (false, format!("Windows could not check taskbar pinning: {e}")),
            },
            Ok(Err(message)) => (false, message),
            Err(e) => (false, format!("Windows could not check taskbar pinning: {e}")),
        }
    }
    #[cfg(not(windows))]
    { let _ = app; (false, String::new()) }
}

#[tauri::command]
pub async fn pin_to_taskbar(app: AppHandle) -> Result<bool, String> {
    #[cfg(windows)]
    {
        {
            let state = app.state::<Presence>();
            let p = state.0.lock().map_err(|_| "Desktop preferences are busy.")?;
            if !p.connected || p.pin_offered { return Err("This taskbar pin offer is no longer available.".into()); }
        }
        let window = app.get_webview_window("main").ok_or("The Cotal window is unavailable.")?;
        if !window.is_focused().map_err(|e| e.to_string())? { return Err("Bring Cotal to the foreground before pinning.".into()); }
        dismiss_presence_offer(app.clone(), "pin".into())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        // Create the consent request on the foreground UI thread, never on the async worker.
        app.run_on_main_thread(move || {
            let operation = taskbar_manager().and_then(|manager| manager.RequestPinCurrentAppAsync().map_err(|e| e.to_string()));
            let _ = tx.send(operation);
        }).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())??.await.map_err(|e| format!("Windows could not pin Cotal: {e}"))
    }
    #[cfg(not(windows))]
    { let _ = app; Err("Taskbar pin requests are available only on supported Windows versions.".into()) }
}
