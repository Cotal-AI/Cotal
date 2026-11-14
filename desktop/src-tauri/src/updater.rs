use serde::Serialize;

#[cfg(all(feature = "updater-e2e", not(debug_assertions)))]
compile_error!("The updater-e2e feature requires debug assertions");

#[cfg(all(feature = "updater-e2e", debug_assertions))]
const ENDPOINT: &str = env!("COTAL_UPDATER_TEST_ENDPOINT");
#[cfg(not(all(feature = "updater-e2e", debug_assertions)))]
const ENDPOINT: &str = "https://github.com/Cotal-AI/Cotal/releases/latest/download/desktop-latest.json";

pub fn compiled_config() -> serde_json::Value {
    serde_json::json!({"schema":1,"endpoints":[ENDPOINT],"test":cfg!(feature = "updater-e2e")})
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
impl UpdateView {
    pub fn disabled() -> Self {
        Self { phase: "unconfigured", version: None, checked_at: None, downloaded: None, total: None,
            reason: Some(if cfg!(target_os = "linux") { "This Linux build cannot update itself because installing a deb or rpm requires administrator rights. Use the matching package installer." } else if cfg!(target_os = "windows") { "This Windows build updates through the installer. Desktop automatic updates are not available yet." } else { "This build cannot update itself. Use the installer to update Cotal." }.into()) }
    }
}

#[cfg(any(not(cotal_updater), not(target_os = "macos")))]
#[tauri::command]
pub async fn app_update_check() -> Result<UpdateView, String> { Ok(UpdateView::disabled()) }

#[cfg(any(not(cotal_updater), not(target_os = "macos")))]
#[tauri::command]
pub async fn app_update_download() -> Result<UpdateView, String> { Ok(UpdateView::disabled()) }

#[cfg(any(not(cotal_updater), not(target_os = "macos")))]
#[tauri::command]
pub async fn app_update_apply() -> Result<UpdateView, String> { Ok(UpdateView::disabled()) }

#[cfg(any(not(cotal_updater), not(target_os = "macos")))]
#[tauri::command]
pub fn app_update_receipt() -> Result<Option<serde_json::Value>, String> { Ok(None) }

#[cfg(all(test, any(not(cotal_updater), not(target_os = "macos"))))]
mod disabled_tests {
    #[test]
    fn no_key_commands_cannot_produce_a_candidate_or_download() {
        let view = tauri::async_runtime::block_on(super::app_update_check()).unwrap();
        assert_eq!(view.phase, "unconfigured");
        assert!(view.version.is_none());
        assert!(view.checked_at.is_none());
        assert!(view.reason.unwrap().contains("installer"));
        let downloaded = tauri::async_runtime::block_on(super::app_update_download()).unwrap();
        assert_eq!(downloaded.phase, "unconfigured");
        assert!(downloaded.version.is_none());
        assert!(downloaded.downloaded.is_none());
        let applied = tauri::async_runtime::block_on(super::app_update_apply()).unwrap();
        assert_eq!(applied.phase, "unconfigured");
        assert!(super::app_update_receipt().unwrap().is_none());
    }
}

#[cfg(all(cotal_updater, target_os = "macos"))]
mod configured {
    use super::UpdateView;
    use crate::{app::RequestSlots, app_activity::Activity, DesktopRequest};
    use std::{fs, io::{Read, Write}, sync::Mutex, time::{Duration, SystemTime, UNIX_EPOCH}};
    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_updater::{Update, UpdaterExt};
    use tokio::sync::Mutex as AsyncMutex;

    use super::ENDPOINT;
    const DAY: u64 = 86_400_000;
    struct Pending { view: UpdateView, update: Option<Update>, bytes: Option<Vec<u8>> }
    pub struct Updates { gate: AsyncMutex<()>, pending: Mutex<Pending>, receipt: Mutex<Option<Result<Receipt, String>>> }
    impl Default for Updates {
        fn default() -> Self {
            Self { gate: AsyncMutex::new(()), pending: Mutex::new(Pending {
                view: UpdateView { phase: "idle", reason: None, ..UpdateView::disabled() }, update: None, bytes: None,
            }), receipt: Mutex::new(None) }
        }
    }
    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Cache { v: u8, checked_at: u64, phase: String, reason: Option<String>, release: Option<serde_json::Value> }
    fn read_cache(app: &AppHandle) -> Result<Updates, String> {
        let state = Updates::default();
        let path = app.path().app_config_dir().map_err(|error| error.to_string())?.join("desktop-update.json");
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(state),
            Err(error) => return Err(error.to_string()),
        };
        let mut bytes = Vec::new();
        file.take(262_145).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() > 262_144 { return Err("Desktop update cache is too large.".into()); }
        let cache: Cache = serde_json::from_slice(&bytes).map_err(|_| "Desktop update cache is invalid.")?;
        if cache.v != 1 || cache.checked_at > now() { return Err("Desktop update cache is unsupported.".into()); }
        let updater = app.updater_builder().endpoints(vec![ENDPOINT.parse().map_err(|_| "Invalid compiled updater endpoint.")?])
            .map_err(|error| error.to_string())?.build().map_err(|error| error.to_string())?;
        let restored = cache.release.map(|release| updater.restore_update(release)).transpose().map_err(|error| error.to_string())?.flatten();
        with_pending(&state, |pending| {
            pending.view.phase = match cache.phase.as_str() {
                "current" if restored.is_none() => "current",
                "available" | "ready" if restored.is_some() => "available",
                "preparing" => "preparing",
                "failed" => "failed",
                _ => "idle",
            };
            pending.view.reason = cache.reason;
            pending.view.version = restored.as_ref().map(|update| update.version.clone());
            pending.view.checked_at = Some(cache.checked_at);
            pending.update = restored;
        })?;
        Ok(state)
    }
    pub fn load(app: &AppHandle) -> Updates {
        let state = match read_cache(app) {
            Ok(state) => state,
            Err(reason) => {
                let state = Updates::default();
                // Cache damage is visible in Settings but must not keep the app window from starting.
                if let Ok(mut pending) = state.pending.lock() { pending.view.phase = "failed"; pending.view.reason = Some(reason); }
                state
            }
        };
        let saved = match receipt_path(app).and_then(|path| crate::update_receipt::take_session(&path)) {
            Ok(Some(receipt)) => Some(Ok(receipt)),
            Ok(None) => None,
            Err(reason) => Some(Err(reason)),
        };
        *state.receipt.lock().expect("new update receipt mutex") = saved;
        state
    }
    fn save(app: &AppHandle, state: &Updates) -> Result<(), String> {
        let cache = with_pending(state, |pending| Cache { v: 1, checked_at: pending.view.checked_at.unwrap_or(0), phase: pending.view.phase.into(), reason: pending.view.reason.clone(), release: pending.update.as_ref().map(|update| update.raw_json.clone()) })?;
        let path = app.path().app_config_dir().map_err(|error| error.to_string())?.join("desktop-update.json");
        fs::create_dir_all(path.parent().ok_or("Desktop update cache directory is unavailable.")?).map_err(|error| error.to_string())?;
        let temporary = path.with_extension(format!("{}.{}.new", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec(&cache).map_err(|error| error.to_string())?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    }
    fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
    fn with_pending<T>(state: &Updates, f: impl FnOnce(&mut Pending) -> T) -> Result<T, String> {
        let mut pending = state.pending.lock().map_err(|_| "Desktop updater state is unavailable.")?;
        Ok(f(&mut pending))
    }
    fn publish(app: &AppHandle, state: &Updates) -> Result<UpdateView, String> {
        let view = with_pending(state, |pending| pending.view.clone())?;
        app.emit("desktop-update", &view).map_err(|error| error.to_string())?;
        Ok(view)
    }

    pub async fn check(app: AppHandle, state: &Updates, manual: bool) -> Result<UpdateView, String> {
        let _guard = state.gate.try_lock().map_err(|_| "A desktop update check or download is already running.")?;
        let previous = with_pending(&state, |pending| pending.view.clone())?;
        if !manual && previous.checked_at.is_some_and(|checked| now().saturating_sub(checked) < DAY) { return Ok(previous); }
        with_pending(&state, |pending| { pending.view.phase = "checking"; pending.view.reason = None; })?;
        publish(&app, &state)?;
        let result = match app.updater_builder().endpoints(vec![ENDPOINT.parse().map_err(|_| "Invalid compiled updater endpoint.")?]) {
            Ok(builder) => match builder.timeout(Duration::from_secs(30)).build() {
                Ok(updater) => updater.check().await,
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        with_pending(&state, |pending| {
            pending.view.checked_at = Some(now());
            match result {
                Ok(Some(update)) => {
                    let same = pending.update.as_ref().is_some_and(|held| held.version == update.version && held.signature == update.signature && held.download_url == update.download_url);
                    if !same { pending.bytes = None; }
                    pending.view.phase = if pending.bytes.is_some() { "ready" } else { "available" };
                    pending.view.version = Some(update.version.clone());
                    pending.view.reason = None;
                    pending.update = Some(update);
                }
                Ok(None) => {
                    pending.view.phase = "current"; pending.view.version = None; pending.view.reason = None;
                    pending.update = None; pending.bytes = None;
                }
                Err(error) => {
                    let preparing = matches!(&error, tauri_plugin_updater::Error::ReleaseNotFound);
                    pending.view.phase = if preparing { "preparing" } else { "failed" };
                    pending.view.reason = if preparing { None } else { Some(error.to_string()) };
                    // A publication gap must not erase a previously verified candidate.
                }
            }
        })?;
        if with_pending(state, |pending| pending.view.phase == "current")? {
            clear_failed_receipt(&app)?;
            *state.receipt.lock().map_err(|_| "Desktop update result is unavailable.")? = None;
        }
        if let Err(reason) = save(&app, &state) {
            with_pending(&state, |pending| { pending.view.phase = "failed"; pending.view.reason = Some(format!("Could not save desktop update check: {reason}")); })?;
        }
        publish(&app, &state)
    }

    async fn download(app: &AppHandle, state: &Updates) -> Result<UpdateView, String> {
        let mut update = with_pending(&state, |pending| {
            pending.update.clone().ok_or_else(|| "No manifest-verified desktop update is available.".to_string())
        })??;
        update.timeout = Some(Duration::from_secs(120));
        with_pending(&state, |pending| { pending.view.phase = "downloading"; pending.view.downloaded = Some(0); pending.view.total = None; pending.view.reason = None; pending.bytes = None; })?;
        publish(&app, &state)?;
        let result = update.download(|chunk, total| {
            if let Ok(mut pending) = state.pending.lock() {
                pending.view.downloaded = Some(pending.view.downloaded.unwrap_or(0).saturating_add(chunk as u64));
                pending.view.total = total;
                let _ = app.emit("desktop-update", &pending.view);
            }
        }, || {}).await;
        with_pending(&state, |pending| match result {
            Ok(bytes) => { pending.bytes = Some(bytes); pending.view.phase = "ready"; pending.view.reason = None; }
            Err(error) => { pending.view.phase = "failed"; pending.view.reason = Some(error.to_string()); }
        })?;
        publish(&app, &state)
    }

    pub use crate::update_receipt::Receipt;

    fn receipt_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
        Ok(app.path().app_config_dir().map_err(|error| error.to_string())?.join("desktop-apply.json"))
    }
    fn write_receipt(app: &AppHandle, receipt: &Receipt) -> Result<(), String> {
        crate::update_receipt::write(&receipt_path(app)?, receipt)
    }
    pub fn receipt(state: &Updates) -> Result<Option<Receipt>, String> {
        state.receipt.lock().map_err(|_| "Desktop update result is unavailable.")?.take().transpose()
    }
    pub fn reopen(app: &AppHandle) -> Result<Option<bool>, String> {
        let state = app.state::<Updates>();
        let saved = state.receipt.lock().map_err(|_| "Desktop update result is unavailable.")?;
        match saved.as_ref() {
            Some(Ok(receipt)) if receipt.relaunch_pending && receipt.target == app.package_info().version.to_string() => Ok(Some(receipt.reopen)),
            _ => Ok(None),
        }
    }
    fn clear_failed_receipt(app: &AppHandle) -> Result<(), String> {
        crate::update_receipt::clear_failed(&receipt_path(app)?)
    }

    async fn automatic(app: &AppHandle) -> Result<bool, String> {
        let slots = app.state::<RequestSlots>();
        let frame = crate::app::run_request(app, &slots, DesktopRequest::UpdatePolicy { auto: None }, None).await?;
        if frame["ok"].as_bool() != Some(true) { return Err("The automatic update preference could not be read.".into()); }
        frame["result"]["auto"].as_bool().ok_or_else(|| "The automatic update preference is unavailable.".into())
    }

    async fn windows(app: &AppHandle, hide: bool) -> Result<bool, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = (|| -> Result<bool, String> {
                let mut visible = false;
                for window in handle.webview_windows().values() {
                    if window.is_visible().map_err(|error| error.to_string())? {
                        visible = true;
                        if hide { window.hide().map_err(|error| error.to_string())?; }
                    }
                }
                Ok(visible)
            })();
            let _ = tx.send(result);
        }).map_err(|error| error.to_string())?;
        rx.await.map_err(|error| error.to_string())?
    }

    fn waiting(app: &AppHandle, state: &Updates, reason: &str) -> Result<UpdateView, String> {
        with_pending(state, |pending| pending.view.reason = Some(reason.into()))?;
        publish(app, state)
    }

    fn unprivileged_replacement(app: &AppHandle) -> Result<bool, String> {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        unsafe extern "C" { fn access(path: *const std::ffi::c_char, mode: std::ffi::c_int) -> std::ffi::c_int; }
        let bundle = crate::native_presence::updater_location(app)?;
        let parent = bundle.parent().ok_or("The app installation has no parent directory.")?;
        for path in [bundle.as_path(), parent] {
            let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| "The app path is invalid.")?;
            // W_OK | X_OK: the actual installing user must be able to modify this directory.
            if unsafe { access(path.as_ptr(), 3) } != 0 { return Ok(false); }
        }
        let probe = parent.join(format!(".cotal-update-{}-{}", std::process::id(), now()));
        match fs::create_dir(&probe) {
            Ok(()) => { fs::remove_dir(probe).map_err(|error| error.to_string())?; Ok(true) }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(30) => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn apply(app: AppHandle, state: &Updates, explicit: bool) -> Result<UpdateView, String> {
        let _gate = match state.gate.try_lock() {
            Ok(guard) => guard,
            Err(_) if !explicit => return with_pending(state, |pending| pending.view.clone()),
            Err(_) => return waiting(&app, state, "A desktop update check or download is running. Try Restart to update when it finishes."),
        };
        if !with_pending(state, |pending| pending.update.is_some())? { return with_pending(state, |pending| pending.view.clone()); }
        if !explicit && windows(&app, false).await? { return with_pending(state, |pending| pending.view.clone()); }
        if !automatic(&app).await? { return waiting(&app, state, "Automatic updates are off. No app files were changed."); }
        if let Err(reason) = crate::native_presence::updater_location(&app) { return waiting(&app, state, &reason); }
        clear_failed_receipt(&app)?;
        *state.receipt.lock().map_err(|_| "Desktop update result is unavailable.")? = None;
        if !with_pending(state, |pending| pending.bytes.is_some())? {
            // No replacement admission during network activity: Open, app operations and Quit still work.
            let view = download(&app, state).await?;
            if view.phase != "ready" { return Ok(view); }
        }
        // A window opened during the download keeps the verified bytes ready without replacing N.
        if !explicit && windows(&app, false).await? { return publish(&app, state); }
        if !explicit && !unprivileged_replacement(&app)? {
            return waiting(&app, state, "This app needs administrator permission to update. Use Restart to update or the installer.");
        }
        let activity = app.state::<Activity>();
        let replacement = activity.replace()?;
        let result: Result<UpdateView, String> = async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while !activity.drained()? {
                if tokio::time::Instant::now() >= deadline {
                    return waiting(&app, state, "An app operation is still running. Finish it, then choose Restart to update.");
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            if !explicit && windows(&app, false).await? { return publish(&app, state); }
            let enabled = tokio::time::timeout(Duration::from_secs(5), automatic(&app)).await
                .map_err(|_| "The automatic update preference did not answer within five seconds. No app files were changed.".to_string())??;
            if !enabled { return waiting(&app, state, "Automatic updates are off. No app files were changed."); }
            crate::native_presence::updater_location(&app)?;
            if !explicit && !unprivileged_replacement(&app)? {
                return waiting(&app, state, "This app needs administrator permission to update. Use Restart to update or the installer.");
            }
            if explicit { windows(&app, true).await?; }
            let (update, bytes) = with_pending(state, |pending| {
                Ok::<_, String>((pending.update.clone().ok_or("The verified update is unavailable.")?, pending.bytes.take().ok_or("The verified download is unavailable.")?))
            })??;
            let mut receipt = Receipt { schema: 1, from: app.package_info().version.to_string(), target: update.version.clone(), phase: "installing".into(), reopen: explicit || activity.take_show_request()?, relaunch_pending: true, reason: None };
            write_receipt(&app, &receipt)?;
            with_pending(state, |pending| { pending.view.phase = "installing"; pending.view.reason = None; })?;
            publish(&app, state)?;
            let install = tauri::async_runtime::spawn_blocking(move || update.install(&bytes)).await.map_err(|error| error.to_string())?;
            if let Err(error) = install {
                receipt.phase = "failed".into(); receipt.relaunch_pending = false; receipt.reason = Some(error.to_string());
                write_receipt(&app, &receipt)?;
                return Err(error.to_string());
            }
            receipt.phase = "installed".into();
            let handle = app.clone();
            app.run_on_main_thread(move || {
                let activity = handle.state::<Activity>();
                let quit = activity.finish().expect("Replacement owns completion");
                receipt.reopen = !quit && (receipt.reopen || activity.take_show_request().unwrap_or(true));
                receipt.relaunch_pending = !quit;
                if let Err(reason) = write_receipt(&handle, &receipt) { eprintln!("The app was replaced but its result could not be finalized: {reason}"); }
                if quit { handle.exit(0); } else { handle.restart(); }
            }).expect("The native event loop must finish replacement");
            std::future::pending::<Result<UpdateView, String>>().await
        }.await;
        let quit = activity.finish()?;
        drop(replacement);
        if let Err(reason) = &result {
            with_pending(state, |pending| { pending.view.phase = "failed"; pending.view.reason = Some(reason.clone()); })?;
            let _ = publish(&app, state);
        }
        if quit { app.exit(0); }
        else if explicit || activity.take_show_request()? { crate::app::show_now(&app); }
        result
    }
}
#[cfg(all(cotal_updater, target_os = "macos"))]
pub use configured::{load, reopen};

#[cfg(all(cotal_updater, target_os = "macos"))]
#[tauri::command]
pub async fn app_update_check(app: tauri::AppHandle, state: tauri::State<'_, configured::Updates>, manual: bool) -> Result<UpdateView, String> {
    configured::check(app, &state, manual).await
}

#[cfg(all(cotal_updater, target_os = "macos"))]
#[tauri::command]
pub async fn app_update_download(app: tauri::AppHandle, state: tauri::State<'_, configured::Updates>) -> Result<UpdateView, String> {
    configured::apply(app, &state, false).await
}

#[cfg(all(cotal_updater, target_os = "macos"))]
#[tauri::command]
pub async fn app_update_apply(app: tauri::AppHandle, state: tauri::State<'_, configured::Updates>, explicit: bool) -> Result<UpdateView, String> {
    configured::apply(app, &state, explicit).await
}

#[cfg(all(cotal_updater, target_os = "macos"))]
#[tauri::command]
pub fn app_update_receipt(state: tauri::State<'_, configured::Updates>) -> Result<Option<configured::Receipt>, String> {
    configured::receipt(&state)
}
