use crate::{browser_url, daemon_env_key, DesktopRequest, NODE_SIDECAR};
use crate::native_presence;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{
    ipc::Channel,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::Semaphore;

const MAX_FRAME: usize = 64 * 1024;
struct RequestSlots(Arc<Semaphore>);
struct TrayStatus(MenuItem<tauri::Wry>);

#[tauri::command]
async fn daemon_request(
    app: AppHandle,
    slots: tauri::State<'_, RequestSlots>,
    request: DesktopRequest,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let _permit = slots
        .0
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Too many app requests are running. Wait for an operation to finish.")?;
    request.validate()?;
    let operation = match &request {
        DesktopRequest::Status {} => "status",
        DesktopRequest::Setup { .. } => "setup",
        _ => "other",
    };
    let seconds = request.timeout_seconds();
    let runtime = app
        .path()
        .resource_dir()
        .map_err(|_| "The packaged runtime is unavailable.")?
        .join("runtime");
    let entry = runtime.join("dist").join("cotal.js");
    if !entry.is_file() {
        return Err(
            "The stock Cotal runtime is missing from this app. Reinstall the complete application."
                .into(),
        );
    }
    let env = std::env::vars().filter(|(key, _)| daemon_env_key(key));
    let command = app
        .shell()
        .sidecar(NODE_SIDECAR)
        .map_err(|_| "The packaged Node runtime is unavailable.")?
        .env_clear()
        .envs(env)
        .env("DO_NOT_TRACK", "1")
        .args([entry.to_string_lossy().as_ref(), "daemon", "desktop"])
        .kill_on_drop(true)
        .set_process_group(false);
    let (mut events, mut child) = command
        .spawn()
        .map_err(|_| "The packaged daemon client could not start.")?;
    let mut input =
        serde_json::to_vec(&request).map_err(|_| "The request could not be encoded.")?;
    input.push(b'\n');
    if child.write(&input).is_err() {
        let _ = child.kill();
        return Err("The daemon client input closed.".into());
    }
    let answer = tokio::time::timeout(Duration::from_secs(seconds), async {
        let mut result = None;
        let mut output_bytes = 0usize;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    output_bytes += line.len();
                    if line.len() > MAX_FRAME || output_bytes > 4 * MAX_FRAME { return Err("The daemon client exceeded its response limit.".to_string()); }
                    let frame: Value = serde_json::from_slice(&line).map_err(|_| "The daemon client returned an invalid JSON frame.")?;
                    if frame.get("v").and_then(Value::as_u64) != Some(1) { return Err("The daemon client protocol is unsupported.".into()); }
                    match frame.get("event").and_then(Value::as_str) {
                        Some("login-prompt" | "setup-progress") => on_event.send(frame).map_err(|_| "The application closed its progress view.")?,
                        Some("result") if result.is_none() => result = Some(frame),
                        _ => return Err("The daemon client returned an unexpected frame.".into()),
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    output_bytes += bytes.len();
                    if output_bytes > 4 * MAX_FRAME { return Err("The daemon client exceeded its diagnostic limit.".into()); }
                    // No raw CLI diagnostics, provider output or paths are copied into the webview.
                }
                CommandEvent::Error(_) => return Err("The daemon client transport failed.".into()),
                CommandEvent::Terminated(payload) => {
                    if payload.code != Some(0) { return Err("The daemon client exited unsuccessfully. No completed operation is assumed.".into()); }
                    return result.ok_or_else(|| "The daemon client exited without a result.".to_string());
                }
                _ => {}
            }
        }
        Err("The daemon client closed without an exit receipt.".into())
    }).await;
    let _ = child.kill();
    let frame = answer.map_err(|_| "The daemon client timed out. The operation outcome is unknown; check status before retrying.".to_string())??;
    if matches!(operation, "status" | "setup") {
        let status = crate::presence::tray_status(&frame);
        app.state::<TrayStatus>().0.set_text(&status).map_err(|e| e.to_string())?;
    }
    // An OS integration refusal does not conceal the completed daemon operation.
    if let Err(message) = native_presence::observe(&app, operation, &frame) {
        app.emit("desktop-presence-error", message).map_err(|e| e.to_string())?;
    }
    Ok(frame)
}

#[tauri::command]
fn open_browser(app: AppHandle, url: String) -> Result<(), String> {
    let url = browser_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "The browser could not be opened.".into())
}

#[tauri::command]
fn set_connection_state(app: AppHandle, connected: bool) -> Result<(), String> {
    let tray = app
        .tray_by_id("machine")
        .ok_or("The system tray is unavailable.")?;
    tray.set_tooltip(Some(if connected {
        "Cotal: connected"
    } else {
        "Cotal: not connected"
    }))
    .map_err(|_| "The tray status could not be updated.".into())
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn run() {
    #[cfg(windows)]
    unsafe {
        windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::w!("ai.cotal.desktop"))
            .expect("Cotal could not set its Windows application identity");
    }
    let autostart = tauri_plugin_autostart::Builder::new().app_name("Cotal").args(["--background"]);
    #[cfg(target_os = "macos")]
    let autostart = autostart.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|arg| arg == "--background") { show(app); }
        }))
        .manage(RequestSlots(Arc::new(Semaphore::new(4))))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(autostart.build())
        .invoke_handler(tauri::generate_handler![
            daemon_request,
            open_browser,
            set_connection_state,
            crate::native_presence::desktop_presence,
            crate::native_presence::set_login_preference,
            crate::native_presence::dismiss_presence_offer,
            crate::native_presence::move_to_applications,
            crate::native_presence::pin_to_taskbar
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            app.manage(native_presence::Presence(std::sync::Mutex::new(native_presence::load(app.handle())?)));
            let status = MenuItem::with_id(app, "status", "Checking connection…", false, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let dashboard = MenuItem::with_id(app, "dashboard", "Open dashboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "Quit Cotal",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&status, &settings, &dashboard, &quit])?;
            app.manage(TrayStatus(status));
            let icon = app
                .default_window_icon()
                .ok_or("The packaged application icon is missing.")?
                .clone();
            TrayIconBuilder::with_id("machine")
                .icon(icon)
                .menu(&menu)
                .tooltip("Cotal: not connected")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => { show(app); let _ = app.emit("desktop-open-settings", ()); }
                    "dashboard" => { show(app); let _ = app.emit("desktop-open-dashboard", ()); }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            if !std::env::args().any(|arg| arg == "--background") {
                show(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                match native_presence::explain_close(window.app_handle()) {
                    Ok(true) => {
                        let _ = window.emit("desktop-close-explained", "Cotal stays in your system tray. Open it from the tray or Dock. Quit app leaves the background service running.");
                        // Keep the first explanation visible until the person closes again.
                        return;
                    }
                    Err(message) => { let _ = window.emit("desktop-presence-error", message); return; }
                    Ok(false) => {}
                }
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Cotal could not initialize its native desktop application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            match event {
                tauri::RunEvent::Reopen { .. } | tauri::RunEvent::Opened { .. } => show(app),
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            { let _ = (app, event); }
        });
}
