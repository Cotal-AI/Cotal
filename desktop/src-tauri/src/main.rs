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

/// The uninstallers' one call before program files go: remove the background service this
/// installation registered, through the packaged runtime's own uninstall.
#[cfg(windows)]
fn remove_windows_service() -> Result<String, String> {
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable.parent().ok_or("the application has no directory")?;
    if cotal_desktop::setup_state::interrupted(directory).map_err(|e| e.to_string())? {
        return Err("setup was interrupted. Run the installer again, then uninstall".into());
    }
    let node = directory.join(format!("{}.exe", cotal_desktop::NODE_SIDECAR));
    let entry = directory.join("runtime").join("dist").join("cotal.js");
    if !node.is_file() || !entry.is_file() {
        return Err("the packaged runtime is incomplete, so the background service could not be removed".into());
    }
    let mut child = Command::new(node)
        .arg(entry)
        .args(["daemon", "desktop"])
        .env_clear()
        .envs(std::env::vars().filter(|(key, _)| cotal_desktop::daemon_env_key(key)))
        .env("DO_NOT_TRACK", "1")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("the packaged runtime could not start: {e}"))?;
    child.stdin.take().ok_or("the runtime has no input")?.write_all(b"{\"op\":\"remove-service\"}\n").map_err(|e| e.to_string())?;
    let mut output = String::new();
    child.stdout.take().ok_or("the runtime has no output")?.take(256 * 1024).read_to_string(&mut output).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    let frame = output
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|frame| frame["event"] == "result")
        .ok_or("the runtime gave no answer, so removal of the background service is unconfirmed")?;
    if frame["ok"] == true {
        Ok(frame["result"]["state"].as_str().unwrap_or("removed").to_string())
    } else {
        Err(frame["error"]["message"].as_str().unwrap_or("the background service could not be removed").to_string())
    }
}

/// The uninstallers' call after the service is removed and before program files go. It ends
/// every process the uninstalling user still runs from this installation: the app, and any status
/// reader it started, which would otherwise keep node.exe in use. A window can start a reader
/// between two passes, so it repeats until a pass finds nothing left.
#[cfg(windows)]
fn close_windows_app() -> Result<usize, String> {
    let executable = std::fs::canonicalize(std::env::current_exe().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let directory = executable.parent().ok_or("the application has no directory")?.to_path_buf();
    let mut closed = 0;
    for _ in 0..10 {
        match end_installation_processes(&directory)? {
            0 => return Ok(closed),
            count => closed += count,
        }
    }
    Err("Cotal processes kept starting from this installation, so it was not removed".into())
}

/// One pass over the process list: end each process of this user whose program is inside
/// `directory`, except this one, and wait for it to exit. Returns how many it ended.
#[cfg(windows)]
fn end_installation_processes(directory: &std::path::Path) -> Result<usize, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};
    let own = unsafe { GetCurrentProcessId() };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(|e| e.to_string())?;
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut ended = 0;
    let mut next = unsafe { Process32FirstW(snapshot, &mut entry) };
    let outcome = loop {
        if next.is_err() { break Ok(ended); }
        if entry.th32ProcessID != own {
            // A process of another user, or one already gone, cannot be opened and is not this user's to end.
            if let Ok(process) = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, entry.th32ProcessID) } {
                let mut buffer = vec![0u16; 32768];
                let mut length = buffer.len() as u32;
                let image = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length) }
                    .ok()
                    .and_then(|_| std::fs::canonicalize(String::from_utf16_lossy(&buffer[..length as usize])).ok());
                let result = match image {
                    Some(image) if image.starts_with(directory) => {
                        let stopped = unsafe { TerminateProcess(process, 1) }.is_ok() && unsafe { WaitForSingleObject(process, 10_000) } == WAIT_OBJECT_0;
                        if stopped { ended += 1; Ok(()) } else { Err(format!("process {} of this installation did not end", entry.th32ProcessID)) }
                    }
                    _ => Ok(()),
                };
                unsafe { let _ = CloseHandle(process); }
                if let Err(message) = result { break Err(message); }
            }
        }
        next = unsafe { Process32NextW(snapshot, &mut entry) };
    };
    unsafe { let _ = CloseHandle(snapshot); }
    outcome
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--updater-config") {
        println!("{}", cotal_desktop::updater::compiled_config());
        return;
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--remove-login") {
        use windows::{core::w, Win32::System::Registry::{RegDeleteKeyValueW, HKEY_CURRENT_USER}};
        // The installer invokes only this fixed operation as its installing user.
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"), w!("Cotal")) };
        std::process::exit(if status.0 == 0 || status.0 == 2 { 0 } else { 1 });
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--remove-service") {
        // The installer reads this line: the outcome on success, the reason otherwise.
        match remove_windows_service() {
            Ok(state) => { println!("{state}"); std::process::exit(0) }
            Err(message) => { println!("{message}"); std::process::exit(1) }
        }
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--close-app") {
        match close_windows_app() {
            Ok(count) => { println!("closed {count}"); std::process::exit(0) }
            Err(message) => { println!("{message}"); std::process::exit(1) }
        }
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--daemon") {
        std::process::exit(serve_windows_daemon().unwrap_or(1));
    }
    cotal_desktop::app::run();
}
