use crate::{browser_url, daemon_env_key, DesktopRequest, NODE_SIDECAR};
use crate::native_presence;
use crate::first_paint::{FirstPaint, ShowAction};
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
pub(crate) struct RequestSlots(Arc<Semaphore>);
struct TrayStatus(MenuItem<tauri::Wry>);
struct SurfaceWord(std::sync::Mutex<String>);
struct AgentCount(std::sync::Mutex<String>);
struct TrayUpdate(MenuItem<tauri::Wry>);
struct PaintState(std::sync::Mutex<FirstPaint>);
struct ActiveWatch(std::sync::Mutex<Option<(u32, tauri_plugin_shell::process::CommandChild)>>);

pub(crate) fn stop_watch(app: &AppHandle) {
    if let Ok(mut active) = app.state::<ActiveWatch>().0.lock() {
        if let Some((_, prev)) = active.take() {
            let _ = prev.kill();
        }
    }
}

#[tauri::command]
async fn daemon_request(
    app: AppHandle,
    slots: tauri::State<'_, RequestSlots>,
    request: DesktopRequest,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let activity = app.state::<crate::app_activity::Activity>().request()?;
    if request.is_watch() {
        drop(activity);
    }
    run_request(&app, &slots, request, Some(on_event)).await
}

pub(crate) async fn run_request(app: &AppHandle, slots: &RequestSlots, request: DesktopRequest, on_event: Option<Channel<Value>>) -> Result<Value, String> {
    let is_watch = request.is_watch();
    let _permit = if is_watch {
        None
    } else {
        Some(
            slots
                .0
                .clone()
                .try_acquire_owned()
                .map_err(|_| "Too many app requests are running. Wait for an operation to finish.")?,
        )
    };
    request.validate()?;
    let operation = match &request {
        DesktopRequest::Status {} | DesktopRequest::StatusWatch {} => "status",
        DesktopRequest::Setup { .. } => "setup",
        DesktopRequest::AgentTerminal { .. } => "agent-terminal",
        _ => "other",
    };
    let seconds = request.timeout_seconds();
    let runtime = app
        .path()
        .resource_dir()
        .map_err(|_| "The packaged runtime is unavailable.")?
        .join("runtime");
    let install = runtime.parent().ok_or("The packaged installation is unavailable.")?;
    let setup_interrupted = match crate::setup_state::interrupted(install) {
        Ok(value) => value,
        Err(_) => return Ok(serde_json::json!({"v":1,"event":"result","ok":false,"error":{"code":"SETUP_INTERRUPTED","message":"Run the installer again to finish updating Cotal."}})),
    };
    if setup_interrupted {
        return Ok(serde_json::json!({"v":1,"event":"result","ok":false,"error":{"code":"SETUP_INTERRUPTED","message":"Run the installer again to finish updating Cotal."}}));
    }
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
    let watch_pid = child.pid();
    let mut input =
        serde_json::to_vec(&request).map_err(|_| "The request could not be encoded.")?;
    input.push(b'\n');
    if child.write(&input).is_err() {
        let _ = child.kill();
        return Err("The daemon client input closed.".into());
    }
    let mut child = if is_watch {
        if let Ok(mut active) = app.state::<ActiveWatch>().0.lock() {
            if let Some((_, prev)) = active.replace((watch_pid, child)) {
                let _ = prev.kill();
            }
        }
        None
    } else {
        Some(child)
    };
    let read_events = async {
        let mut agent_terminal = None;
        let mut result = None;
        let mut output_bytes = 0usize;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    if !is_watch {
                        output_bytes += line.len();
                    }
                    if line.len() > MAX_FRAME || output_bytes > 4 * MAX_FRAME { return Err("The daemon client exceeded its response limit.".to_string()); }
                    let mut frame: Value = serde_json::from_slice(&line).map_err(|_| "The daemon client returned an invalid JSON frame.")?;
                    if frame.get("v").and_then(Value::as_u64) != Some(1) { return Err("The daemon client protocol is unsupported.".into()); }
                    match frame.get("event").and_then(Value::as_str) {
                        Some("login-prompt" | "setup-progress" | "agent-app-progress" | "repair-progress") => on_event.as_ref().ok_or("Unexpected progress from the update preference reader.")?.send(frame).map_err(|_| "The application closed its progress view.")?,
                        Some("status") if is_watch => {
                            if agent_terminal.is_none() { agent_terminal = Some(terminal_available().await); }
                            frame["result"]["agentTerminal"] = Value::Bool(agent_terminal.unwrap_or(false));
                            write_tray(app, &frame)?;
                            if let Err(message) = native_presence::observe(app, "status", &frame) {
                                app.emit("desktop-presence-error", message).map_err(|e| e.to_string())?;
                            }
                            on_event.as_ref().ok_or("Unexpected status stream without an event channel.")?.send(frame).map_err(|_| "The application closed its status view.")?;
                        }
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
                    if is_watch {
                        let still_active = app
                            .state::<ActiveWatch>()
                            .0
                            .lock()
                            .ok()
                            .and_then(|mut active| {
                                if active.as_ref().is_some_and(|(p, _)| *p == watch_pid) {
                                    active.take().map(|(_, c)| {
                                        let _ = c.kill();
                                    })
                                } else {
                                    None
                                }
                            })
                            .is_some();
                        if !still_active {
                            return Ok(serde_json::json!({"v":1,"event":"result","ok":true,"result":{"closed":true,"watchMode":"push"}}));
                        }
                    }
                    if payload.code != Some(0) { return Err("The daemon client exited unsuccessfully. No completed operation is assumed.".into()); }
                    return result.ok_or_else(|| "The daemon client exited without a result.".to_string());
                }
                _ => {}
            }
        }
        Err("The daemon client closed without an exit receipt.".into())
    };
    let frame = if is_watch {
        read_events.await
    } else {
        tokio::time::timeout(Duration::from_secs(seconds), read_events)
            .await
            .map_err(|_| "The daemon client timed out. The operation outcome is unknown; check status before retrying.".to_string())?
    };
    if let Some(c) = child.take() {
        let _ = c.kill();
    } else if is_watch {
        if let Ok(mut active) = app.state::<ActiveWatch>().0.lock() {
            if active.as_ref().is_some_and(|(p, _)| *p == watch_pid) {
                if let Some((_, c)) = active.take() {
                    let _ = c.kill();
                }
            }
        }
    }
    let mut frame = frame?;
    if frame.get("ok").and_then(Value::as_bool) == Some(true) {
        if operation == "agent-terminal" { return launch_agent_terminal(&mut frame).await; }
        if operation == "status" && !is_watch { frame["result"]["agentTerminal"] = Value::Bool(terminal_available().await); }
    }
    if (!is_watch && matches!(operation, "status" | "setup"))
        || (is_watch && frame.get("ok").and_then(Value::as_bool) == Some(false))
    {
        write_tray(app, &frame)?;
    }
    // An OS integration refusal does not conceal the completed daemon operation.
    if !is_watch {
        if let Err(message) = native_presence::observe(app, operation, &frame) {
            app.emit("desktop-presence-error", message).map_err(|e| e.to_string())?;
        }
    }
    Ok(frame)
}

async fn terminal_available() -> bool {
    tauri::async_runtime::spawn_blocking(crate::terminal::available).await.unwrap_or(false)
}

async fn launch_agent_terminal(frame: &mut Value) -> Result<Value, String> {
    let argv: Vec<String> = serde_json::from_value(frame["result"]["argv"].take())
        .map_err(|_| "The background service returned an invalid terminal command.")?;
    tauri::async_runtime::spawn_blocking(move || crate::terminal::launch(&argv)).await.map_err(|e| e.to_string())??;
    Ok(serde_json::json!({"v":1,"event":"result","ok":true,"result":{"started":true}}))
}

#[tauri::command]
fn open_browser(app: AppHandle, url: String) -> Result<(), String> {
    let url = browser_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "The browser could not be opened.".into())
}

#[tauri::command]
fn set_update_notice(app: AppHandle, version: Option<String>) -> Result<(), String> {
    if let Some(value) = &version { if value.len() > 64 || !value.bytes().all(|c| c.is_ascii_digit() || c == b'.') { return Err("Invalid update version.".into()); } }
    let item = &app.state::<TrayUpdate>().0;
    item.set_text(version.as_ref().map(|v| format!("Cotal {v} available…")).unwrap_or_else(|| "No desktop update".into())).map_err(|e| e.to_string())?;
    item.set_enabled(version.is_some()).map_err(|e| e.to_string())
}

fn write_tray(app: &AppHandle, frame: &Value) -> Result<(), String> {
    let agents = crate::presence::agent_count(frame);
    *app.state::<AgentCount>().0.lock().map_err(|_| "The tray state was poisoned.")? = agents.clone();
    let word = app.state::<SurfaceWord>().0.lock().map_err(|_| "The tray state was poisoned.")?.clone();
    let menu = crate::presence::tray_menu(&word, &agents);
    app.state::<TrayStatus>().0.set_text(&menu).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_connection_state(app: AppHandle, connected: bool, label: String) -> Result<(), String> {
    // Keep the connection argument in the command contract. The label alone drives the tray copy.
    let _ = connected;
    let word = crate::presence::tray_word(&label);
    *app.state::<SurfaceWord>().0.lock().map_err(|_| "The tray state was poisoned.")? = word.to_string();
    let agents = app.state::<AgentCount>().0.lock().map_err(|_| "The tray state was poisoned.")?.clone();
    let menu = crate::presence::tray_menu(word, &agents);
    app.state::<TrayStatus>().0.set_text(&menu).map_err(|error| error.to_string())?;
    let tray = app
        .tray_by_id("machine")
        .ok_or("The system tray is unavailable.")?;
    tray.set_tooltip(Some(format!("Cotal: {word}")))
    .map_err(|_| "The tray status could not be updated.".into())
}

fn show(app: &AppHandle) {
    let action = app.state::<PaintState>().0.lock().expect("first paint state poisoned").request();
    match action {
        ShowAction::Show => show_now(app),
        ShowAction::Wait => {},
        ShowAction::StartTimer => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let action = handle.state::<PaintState>().0.lock().expect("first paint state poisoned").timeout();
                    if action == ShowAction::Show {
                        let _ = handle.emit("desktop-presence-error", "Cotal did not finish drawing its first frame within two seconds.");
                        show_now(&handle);
                    }
                });
            });
        }
    }
}

#[tauri::command]
fn first_paint(window: tauri::WebviewWindow) -> Result<bool, String> {
    if window.label() != "main" { return Err("Only the main window can report its first frame.".into()); }
    let app = window.app_handle();
    let action = app.state::<PaintState>().0.lock().map_err(|_| "The first frame state is unavailable.")?.painted();
    if action == ShowAction::Show { show_now(app); }
    window.is_visible().map_err(|e| e.to_string())
}

pub(crate) fn show_now(app: &AppHandle) {
    let activity = app.state::<crate::app_activity::Activity>();
    if let Err(reason) = activity.show(|| show_window(app)) {
        let _ = app.emit("desktop-presence-error", reason);
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let result = (|| -> tauri::Result<()> {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular)?;
            window.show()?;
            window.unminimize()?;
            window.set_focus()?;
            let _ = window.emit("desktop-shown", ());
            Ok(())
        })();
        if let Err(error) = result {
            let _ = app.emit("desktop-presence-error", format!("Cotal could not show its window: {error}"));
        }
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
        .manage(PaintState(std::sync::Mutex::new(FirstPaint::default())))
        .manage(ActiveWatch(std::sync::Mutex::new(None)))
        .manage(crate::app_activity::Activity::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(autostart.build())
        .invoke_handler(tauri::generate_handler![
            daemon_request,
            open_browser,
            set_connection_state,
            first_paint,
            crate::native_presence::desktop_presence,
            crate::native_presence::set_login_preference,
            crate::native_presence::dismiss_presence_offer,
            crate::native_presence::move_to_applications,
            set_update_notice,
            crate::native_presence::pin_to_taskbar,
            crate::updater::app_update_check,
            crate::updater::app_update_download,
            crate::updater::app_update_apply,
            crate::updater::app_update_receipt
        ])
        .setup(|app| {
            #[cfg(all(cotal_updater, not(target_os = "linux")))]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new()
                    .pubkey(env!("COTAL_UPDATER_PUBLIC_KEY")).build())?;
                app.manage(crate::updater::load(app.handle()));
            }
            let window = app.get_webview_window("main").ok_or("The main window is unavailable.")?;
            window.set_background_color(Some(tauri::window::Color(255, 252, 238, 255)))?;
            #[cfg(target_os = "macos")]
            app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?;
            #[allow(unused_mut)]
            let mut presence = native_presence::load(app.handle())?;
            #[cfg(target_os = "macos")]
            if let Err(reason) = crate::command_line::ensure_on_shell_path(app.handle()) {
                presence.1 = Some(match presence.1.take() { Some(notice) => format!("{notice}\n{reason}"), None => reason });
            }
            app.manage(presence);
            let status = MenuItem::with_id(app, "status", "Starting", false, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let repair = MenuItem::with_id(app, "repair", "Repair…", true, None::<&str>)?;
            let dashboard = MenuItem::with_id(app, "dashboard", "Open dashboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "Quit app (computer stays connected)",
                true,
                None::<&str>,
            )?;
            let update = MenuItem::with_id(app, "update", "No desktop update", false, None::<&str>)?;
            let menu = Menu::with_items(app, &[&status, &update, &settings, &repair, &dashboard, &quit])?;
            app.manage(TrayUpdate(update));
            app.manage(TrayStatus(status));
            app.manage(SurfaceWord(std::sync::Mutex::new(String::new())));
            app.manage(AgentCount(std::sync::Mutex::new(String::new())));
            let icon = app
                .default_window_icon()
                .ok_or("The packaged application icon is missing.")?
                .clone();
            TrayIconBuilder::with_id("machine")
                .icon(icon)
                .menu(&menu)
                .tooltip("Cotal: Starting")
                .show_menu_on_left_click(true)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        tauri::tray::TrayIconEvent::Click { .. }
                            | tauri::tray::TrayIconEvent::DoubleClick { .. }
                    ) {
                        let _ = tray.app_handle().emit("desktop-tray-open", ());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "update" => { show(app); let _ = app.emit("desktop-open-settings", ()); }
                    "settings" => { show(app); let _ = app.emit("desktop-open-settings", ()); }
                    "repair" => { show(app); let _ = app.emit("desktop-open-repair", ()); }
                    "dashboard" => { show(app); let _ = app.emit("desktop-open-dashboard", ()); }
                    "quit" => { if app.state::<crate::app_activity::Activity>().request_exit() { stop_watch(app); app.exit(0); } },
                    _ => {}
                })
                .build(app)?;
            let open = !std::env::args().any(|arg| arg == "--background");
            #[cfg(all(cotal_updater, not(target_os = "linux")))]
            let open = match crate::updater::reopen(app.handle()) {
                Ok(Some(reopen)) => reopen,
                Ok(None) => open,
                Err(reason) => { let _ = app.emit("desktop-presence-error", reason); open },
            };
            if open { show(app.handle()); }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                match native_presence::explain_close(window.app_handle()) {
                    Ok(true) => {
                        #[cfg(target_os = "macos")]
                        let message = "Closing this window keeps Cotal in the menu bar, not the Dock. Open it from the menu bar or Applications. Quitting the app leaves this computer connected.";
                        #[cfg(not(target_os = "macos"))]
                        let message = "Closing this window keeps Cotal in your system tray. Open it from the tray. Quitting the app leaves this computer connected.";
                        let _ = window.emit("desktop-close-explained", message);
                        // Keep the first explanation visible until the person closes again.
                        return;
                    }
                    Err(message) => { let _ = window.emit("desktop-presence-error", message); return; }
                    Ok(false) => {}
                }
                let result = (|| -> tauri::Result<()> {
                    window.hide()?;
                    let _ = window.emit("desktop-hidden", ());
                    #[cfg(target_os = "macos")]
                    window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?;
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = window.emit("desktop-presence-error", format!("Cotal could not hide its window: {error}"));
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Cotal could not initialize its native desktop application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if !app.state::<crate::app_activity::Activity>().request_exit() { api.prevent_exit(); }
                else { stop_watch(app); }
            }
            #[cfg(target_os = "macos")]
            match event {
                tauri::RunEvent::Reopen { .. } | tauri::RunEvent::Opened { .. } => show(app),
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            { let _ = (app, event); }
        });
}
