use std::path::Path;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::{Command, Stdio};

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn desktop_environment(command: &mut Command) -> &mut Command {
    command.env_clear().envs(std::env::vars_os().filter(|(key, _)| ["PATH", "HOME", "USER", "LOGNAME", "LANG", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS"].iter().any(|allowed| key == *allowed)))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
}

#[cfg(target_os = "linux")]
fn linux_terminal() -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("xdg-terminal-exec"))
        .find(|file| file.metadata().is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0))
        .filter(|file| desktop_environment(Command::new(file).arg("--print-id")).status().is_ok_and(|status| status.success()))
}

pub(crate) fn available() -> bool {
    #[cfg(target_os = "linux")]
    { linux_terminal().is_some() }
    #[cfg(not(target_os = "linux"))]
    { cfg!(target_os = "macos") }
}

fn validate(argv: &[String]) -> bool {
    let atom = |s: &str| !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c));
    argv.len() == 8 && argv.iter().all(|arg| !arg.chars().any(char::is_control))
        && Path::new(&argv[0]).is_absolute() && Path::new(&argv[1]).is_absolute()
        && argv[2] == "attach" && atom(&argv[3]) && !argv[3].starts_with('-')
        && argv[4] == "--on" && atom(&argv[5]) && argv[6] == "--space" && atom(&argv[7])
}

#[cfg(any(target_os = "macos", test))]
fn mac_script(argv: &[String]) -> String {
    let words = argv.iter().map(|arg| format!("'{}'", arg.replace('\'', "'\\''"))).collect::<Vec<_>>().join(" ");
    format!("#!/bin/sh\n/bin/rm -f -- \"$0\"\n/bin/rmdir -- \"${{0%/*}}\"\nexec {words}\n")
}

#[cfg(any(target_os = "macos", test))]
fn mac_args(path: &Path) -> [&std::ffi::OsStr; 1] { [path.as_os_str()] }

#[cfg(any(target_os = "linux", test))]
fn linux_args(argv: &[String]) -> Vec<&str> {
    std::iter::once("--").chain(argv.iter().map(String::as_str)).collect()
}

pub(crate) fn launch(argv: &[String]) -> Result<(), String> {
    if !validate(argv) { return Err("The background service returned an invalid terminal command.".into()); }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return Err("No supported default terminal is available.".into());
    #[cfg(target_os = "linux")]
    let mut command = {
        let terminal = linux_terminal().ok_or("No supported default terminal is available.")?;
        let mut command = Command::new(terminal);
        command.args(linux_args(argv));
        command
    };
    #[cfg(target_os = "macos")]
    let (mut command, cleanup) = {
        use std::io::Write;
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let dir = std::env::temp_dir().join(format!("cotal-attach-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos()));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|e| format!("Could not create the terminal command: {e}"))?;
        let path = dir.join("Attach.command");
        let cleanup = move || { let _ = std::fs::remove_dir_all(&dir); };
        if let Err(error) = std::fs::OpenOptions::new().create_new(true).write(true).mode(0o700).open(&path).and_then(|mut file| file.write_all(mac_script(argv).as_bytes())) {
            cleanup();
            return Err(format!("Could not write the terminal command: {error}"));
        }
        let mut command = Command::new("/usr/bin/open");
        command.args(mac_args(&path));
        (command, cleanup)
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let result = desktop_environment(&mut command);
        #[cfg(target_os = "linux")]
        {
            let mut child = result.spawn().map_err(|e| format!("Could not start the default terminal: {e}"))?;
            std::thread::spawn(move || { let _ = child.wait(); });
            Ok(())
        }
        #[cfg(target_os = "macos")]
        match result.status() {
            Ok(status) if status.success() => Ok(()),
            verdict => { cleanup(); Err(format!("Could not open the terminal command: {}", match verdict { Ok(status) => status.to_string(), Err(error) => error.to_string() })) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_launch_keeps_cli_arguments_separate() {
        let argv = ["/opt/Cotal's Node", "/opt/Cotal App/cotal.js", "attach", "writer", "--on", "manager", "--space", "team"].map(str::to_owned);
        assert!(validate(&argv));
        assert_eq!(linux_args(&argv), ["--", "/opt/Cotal's Node", "/opt/Cotal App/cotal.js", "attach", "writer", "--on", "manager", "--space", "team"]);
        assert_eq!(mac_args(Path::new("/tmp/a b/Attach.command")), [std::ffi::OsStr::new("/tmp/a b/Attach.command")]);
        assert!(mac_script(&argv).ends_with("exec '/opt/Cotal'\\''s Node' '/opt/Cotal App/cotal.js' 'attach' 'writer' '--on' 'manager' '--space' 'team'\n"));
        let mut invalid = argv;
        invalid[3] = "--creds".into();
        assert!(!validate(&invalid));
    }
}
