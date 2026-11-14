#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
fn serve_windows_daemon() -> Result<i32, Box<dyn std::error::Error>> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let args: Vec<_> = std::env::args_os().skip(2).collect();
    if !(args.is_empty()
        || (args.len() == 2
            && args[0] == "--daemon-home"
            && std::path::Path::new(&args[1]).is_absolute()))
    {
        return Err("the background launcher accepts only an optional absolute daemon home".into());
    }
    // Tauri's Windows resource_dir is the executable's directory (tauri-utils platform.rs).
    let executable = std::env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or("the application has no directory")?;
    if cotal_desktop::setup_state::interrupted(directory)? {
        return Err("setup was interrupted, run the installer again".into());
    }
    let node = directory.join(format!("{}.exe", cotal_desktop::NODE_SIDECAR));
    let runtime = directory.join("runtime");
    let entry = runtime.join("dist").join("daemon-native.js");
    if !node.is_file() || !entry.is_file() || !runtime.join("desktop-runtime.json").is_file() {
        return Err("the complete packaged stock runtime is required".into());
    }
    // Task Scheduler supervises this process. It returns the one child's result without retrying.
    // It never initializes a tray/webview or enters the app's single-instance handler.
    let status = Command::new(node)
        .args(["--max-semi-space-size=1"])
        .arg(entry)
        .args(["daemon", "serve"])
        .args(args)
        .env_clear()
        .envs(std::env::vars().filter(|(key, _)| cotal_desktop::daemon_env_key(key)))
        .env("DO_NOT_TRACK", "1")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW; Node remains the unmodified signed executable.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    Ok(status.code().unwrap_or(1))
}

fn main() {
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--remove-login") {
        use windows::{core::w, Win32::System::Registry::{RegDeleteKeyValueW, HKEY_CURRENT_USER}};
        // The installer invokes only this fixed operation as its installing user.
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"), w!("Cotal")) };
        std::process::exit(if status.0 == 0 || status.0 == 2 { 0 } else { 1 });
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--daemon") {
        std::process::exit(serve_windows_daemon().unwrap_or(1));
    }
    cotal_desktop::app::run();
}
