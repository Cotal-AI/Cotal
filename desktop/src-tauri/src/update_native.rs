#[cfg(feature = "desktop")]
mod native {
    use crate::updates::Snapshot;
    use crate::{app::daemon_call, DesktopRequest};
    use serde_json::Value;
    use std::sync::Mutex;
    use std::{sync::Arc, time::Duration};
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_updater::{Update, UpdaterExt};
    use tokio::sync::Mutex as AsyncMutex;

    pub struct UpdaterState {
        pub snapshot: Mutex<Snapshot>,
        pending: AsyncMutex<Option<(Update, Vec<u8>)>>,
        work: AsyncMutex<()>,
    }
    impl Default for UpdaterState {
        fn default() -> Self {
            Self {
                snapshot: Mutex::new(Snapshot::default()),
                pending: AsyncMutex::new(None),
                work: AsyncMutex::new(()),
            }
        }
    }
    fn publish(app: &AppHandle, snapshot: Snapshot) {
        *app.state::<UpdaterState>()
            .snapshot
            .lock()
            .expect("updater state poisoned") = snapshot.clone();
        let _ = app.emit("desktop-update", snapshot);
    }
    fn result(frame: Value) -> Result<Value, String> {
        if frame.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(frame
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("The update operation was refused.")
                .to_owned());
        }
        frame
            .get("result")
            .cloned()
            .ok_or_else(|| "The update reply is incomplete.".into())
    }
    async fn automatic(app: &AppHandle) -> Result<bool, String> {
        let policy =
            result(daemon_call(app, DesktopRequest::DesktopPolicy { auto: None }, None).await?)?;
        policy
            .get("auto")
            .and_then(Value::as_bool)
            .ok_or_else(|| "The shared update preference is unavailable.".into())
    }
    fn unavailable() -> Option<String> {
        if option_env!("COTAL_UPDATER_PUBLIC_KEY")
            .unwrap_or("")
            .is_empty()
        {
            return Some(
                "This build has no update verification key. Install the signed platform release."
                    .into(),
            );
        }
        #[cfg(target_os = "macos")]
        if option_env!("COTAL_MACOS_NOTARIZED") != Some("1") {
            return Some("This macOS build is not Developer ID signed and notarized. Install the platform release approved for your Mac.".into());
        }
        None
    }
    #[tauri::command]
    pub fn desktop_update_status(app: AppHandle) -> Result<Snapshot, String> {
        app.state::<UpdaterState>()
            .snapshot
            .lock()
            .map(|s| s.clone())
            .map_err(|_| "The updater state is unavailable.".into())
    }
    #[tauri::command]
    pub async fn desktop_update_check(app: AppHandle) -> Result<Snapshot, String> {
        check(&app).await;
        desktop_update_status(app)
    }
    async fn check(app: &AppHandle) {
        let state = app.state::<UpdaterState>();
        let Ok(_work) = state.work.try_lock() else {
            return;
        };
        if let Some(reason) = unavailable() {
            publish(
                app,
                Snapshot {
                    phase: "unavailable",
                    reason: Some(reason),
                    ..Snapshot::default()
                },
            );
            return;
        }
        let outcome: Result<(), String> = async {
            publish(app, Snapshot::default());
            let updater = app
                .updater_builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            let Some(mut update) = updater.check().await.map_err(|e| e.to_string())? else {
                publish(
                    app,
                    Snapshot {
                        phase: "current",
                        ..Snapshot::default()
                    },
                );
                return Ok(());
            };
            if update.download_url.scheme() != "https" {
                return Err("The release artifact must use HTTPS.".into());
            }
            let version = update.version.clone();
            if !automatic(app).await? {
                publish(
                    app,
                    Snapshot {
                        phase: "off",
                        version: Some(version),
                        ..Snapshot::default()
                    },
                );
                return Ok(());
            }
            update.timeout = Some(Duration::from_secs(600));
            let observed = Arc::new(Mutex::new(0u64));
            let bytes = update
                .download(
                    |chunk, total| {
                        let mut count = observed.lock().expect("download progress poisoned");
                        *count += chunk as u64;
                        publish(
                            app,
                            Snapshot {
                                phase: "downloading",
                                version: Some(version.clone()),
                                downloaded: *count,
                                total,
                                reason: None,
                            },
                        );
                    },
                    || {},
                )
                .await
                .map_err(|e| e.to_string())?;
            *state.pending.lock().await = Some((update, bytes));
            publish(
                app,
                Snapshot {
                    phase: "ready",
                    version: Some(version),
                    reason: Some("Waiting for a quiet moment to install.".into()),
                    ..Snapshot::default()
                },
            );
            Ok(())
        }
        .await;
        if let Err(reason) = outcome {
            publish(
                app,
                Snapshot {
                    phase: "failed",
                    reason: Some(reason),
                    ..Snapshot::default()
                },
            );
        }
    }
    async fn apply_ready(app: &AppHandle) -> Result<(), String> {
        let state = app.state::<UpdaterState>();
        let Ok(_work) = state.work.try_lock() else {
            return Ok(());
        };
        let mut pending = state.pending.lock().await;
        let Some((update, bytes)) = pending.as_ref() else {
            return Ok(());
        };
        if !automatic(app).await? {
            publish(
                app,
                Snapshot {
                    phase: "off",
                    version: Some(update.version.clone()),
                    ..Snapshot::default()
                },
            );
            return Ok(());
        }
        #[cfg(windows)]
        {
            return Err(
                "Windows update installation is waiting for a verified service handoff.".into(),
            );
        }
        #[cfg(not(windows))]
        {
            let admission = app.state::<crate::updates::UpdateAdmission>();
            if admission
                .0
                .lock()
                .map_err(|_| "Update admission is unavailable.")?
                .begin_install()
                .is_err()
            {
                return Ok(());
            }
            let outcome: Result<(), String> = async {
                let prepared = daemon_call(app, DesktopRequest::UpdatePrepare {}, None).await?;
                result(prepared)?;
                {
                    let status = result(daemon_call(app, DesktopRequest::Status {}, None).await?)?;
                    let evidence = status.pointer("/update/restartEvidence").ok_or(
                        "The background service did not return update admission evidence.",
                    )?;
                    if evidence.get("prepared").and_then(Value::as_bool) != Some(true) {
                        return Err("The background service has not held update admission.".into());
                    }
                    let managers = evidence
                        .get("managers")
                        .and_then(Value::as_array)
                        .ok_or("The Manager update evidence is incomplete.")?;
                    if managers.iter().any(|row| {
                        row.get("seats").and_then(Value::as_u64) != Some(0)
                            || row.get("fenced").and_then(Value::as_bool) != Some(true)
                    }) {
                        return Err("Waiting for running agents to finish.".into());
                    }
                }
                if !automatic(app).await? {
                    return Err("Automatic installation was switched off.".into());
                }
                update.install(bytes).map_err(|e| e.to_string())?;
                Ok(())
            }
            .await;
            if let Err(error) = outcome {
                let rollback = daemon_call(app, DesktopRequest::UpdateAbort {}, None).await;
                admission
                    .0
                    .lock()
                    .map_err(|_| "Update admission is unavailable.")?
                    .end_install();
                if let Err(rollback_error) = rollback {
                    return Err(format!(
                        "{error}. Update admission could not be released: {rollback_error}"
                    ));
                }
                return Err(error);
            }
            pending.take();
            app.restart();
        }
    }
    pub fn start(app: &AppHandle) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            check(&handle).await;
            let mut elapsed = 0u64;
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if let Err(reason) = apply_ready(&handle).await {
                    let state = handle.state::<UpdaterState>();
                    let current = state
                        .snapshot
                        .lock()
                        .expect("updater state poisoned")
                        .clone();
                    state.pending.lock().await.take();
                    publish(
                        &handle,
                        Snapshot {
                            phase: "failed",
                            reason: Some(reason),
                            ..current
                        },
                    );
                }
                elapsed += 30;
                if elapsed >= 3600 {
                    check(&handle).await;
                    elapsed = 0;
                }
            }
        });
    }
}
#[cfg(feature = "desktop")]
pub use native::*;
