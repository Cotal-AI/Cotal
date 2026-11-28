//! The `cotal` command that comes with the app: its bundled CLI run by its bundled Node.
//!
//! The launcher sits in a `bin` folder of its own inside the installation, so an update replaces
//! it in place and uninstalling removes it. That folder always goes last on PATH: a `cotal` that npm
//! or the shell installer already put on PATH stays the one that runs.
//! Windows installers add the folder to the user PATH and remove it again on uninstall. A macOS
//! disk image runs no installer, so the app adds the line itself the first time it runs from a
//! lasting location. Linux packages link `/usr/bin/cotal` in their own scripts.

use std::path::{Path, PathBuf};

/// Whether a PATH entry names `dir`, the way Windows resolves it: variables expanded, a trailing
/// separator ignored, any case.
fn same_entry(entry: &str, dir: &str, expand: &dyn Fn(&str) -> String) -> bool {
    let key = |value: &str| expand(value).trim_end_matches('\\').to_lowercase();
    !entry.is_empty() && key(entry) == key(dir)
}

/// A Windows PATH value with `dir` after its last entry, or `None` when it already names `dir`.
/// Trailing semicolons stay at the end (Windows writes its default user PATH with one), so
/// taking `dir` out again gives back the value exactly.
pub fn windows_path_with(path: &str, dir: &str, expand: &dyn Fn(&str) -> String) -> Option<String> {
    if path.split(';').any(|entry| same_entry(entry, dir, expand)) { return None; }
    if path.is_empty() { return Some(dir.to_string()); }
    let kept = path.trim_end_matches(';');
    Some(format!("{kept};{dir}{}", &path[kept.len()..]))
}

/// A Windows PATH value without `dir`, or `None` when it does not name `dir`. Every other entry
/// keeps its exact spelling and place.
pub fn windows_path_without(path: &str, dir: &str, expand: &dyn Fn(&str) -> String) -> Option<String> {
    if !path.split(';').any(|entry| same_entry(entry, dir, expand)) { return None; }
    Some(path.split(';').filter(|entry| !same_entry(entry, dir, expand)).collect::<Vec<_>>().join(";"))
}

/// The startup files a login shell reads, for the shells whose PATH grammar is known, chosen as
/// the bundled CLI chooses them when it adds an agent application's folder
/// (`bin/daemon/desktop-agent-apps.ts`). A bash login shell reads the first of `.bash_profile`,
/// `.bash_login` and `.profile`, and a terminal's bash reads `.bashrc`, so bash gets both.
pub fn shell_startup_files(shell: &str, home: &Path, exists: &dyn Fn(&Path) -> bool) -> Result<Vec<PathBuf>, String> {
    match Path::new(shell).file_name().and_then(|name| name.to_str()).unwrap_or("") {
        "zsh" => Ok(vec![home.join(".zshrc")]),
        "bash" => {
            let login = [".bash_profile", ".bash_login", ".profile"].iter().map(|name| home.join(name))
                .find(|file| exists(file)).unwrap_or_else(|| home.join(".profile"));
            Ok(vec![login, home.join(".bashrc")])
        }
        "fish" => Ok(vec![home.join(".config").join("fish").join("conf.d").join("cotal-app.fish")]),
        _ => Err(format!("Cotal could not put its cotal command on PATH for the login shell {}.", if shell.is_empty() { "(none)" } else { shell })),
    }
}

/// The startup-file line that puts `dir` last on PATH, in the grammar of `shell`.
pub fn shell_path_line(shell: &str, dir: &str) -> String {
    if Path::new(shell).file_name().is_some_and(|name| name == "fish") {
        return format!("fish_add_path --path --append '{}'", dir.replace('\\', "\\\\").replace('\'', "\\'"));
    }
    let mut quoted = String::new();
    for c in dir.chars() {
        if matches!(c, '\\' | '"' | '$' | '`') { quoted.push('\\'); }
        quoted.push(c);
    }
    format!("export PATH=\"$PATH:{quoted}\"")
}

/// Add (`present`) or remove this installation's `bin` folder on the current user's PATH, keeping
/// the value's registry type so `%VAR%` entries stay as they are, then tell running programs the
/// environment changed. The Windows installers call this through `--add-command-line` and
/// `--remove-command-line`. Returns what it did.
#[cfg(all(windows, feature = "desktop"))]
pub fn set_on_user_path(present: bool) -> Result<String, String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_VALUE_TYPE, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let bin = executable.parent().ok_or("the application has no directory")?.join("bin");
    if present && !bin.join("cotal.cmd").is_file() {
        return Err(format!("{} has no cotal.cmd. Run the installer again.", bin.display()));
    }
    let dir = bin.to_str().ok_or("the installation folder name is not valid Unicode")?;
    if dir.contains(';') { return Err(format!("{dir} contains a semicolon, so it cannot be a PATH entry")); }
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    let (mut kind, mut bytes) = (REG_VALUE_TYPE::default(), 0u32);
    let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, w!("Environment"), w!("Path"), flags, Some(&mut kind), None, Some(&mut bytes)) };
    let path = match status.0 {
        2 => { kind = REG_EXPAND_SZ; String::new() }
        0 => {
            let mut words = vec![0u16; (bytes as usize).div_ceil(2)];
            let mut actual = (words.len() * 2) as u32;
            let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, w!("Environment"), w!("Path"), flags, Some(&mut kind), Some(words.as_mut_ptr().cast()), Some(&mut actual)) };
            if status.0 != 0 { return Err(format!("the user PATH could not be read ({})", status.0)); }
            let words = &words[..(actual as usize / 2).min(words.len())];
            String::from_utf16_lossy(&words[..words.iter().position(|&c| c == 0).unwrap_or(words.len())])
        }
        code => return Err(format!("the user PATH could not be read ({code})")),
    };
    let expand = |value: &str| -> String {
        let source: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
        let needed = unsafe { ExpandEnvironmentStringsW(PCWSTR(source.as_ptr()), None) };
        let mut out = vec![0u16; needed as usize];
        let written = unsafe { ExpandEnvironmentStringsW(PCWSTR(source.as_ptr()), Some(&mut out)) };
        if needed == 0 || written == 0 || written > needed { return value.to_string(); }
        String::from_utf16_lossy(&out[..written as usize - 1])
    };
    let next = if present { windows_path_with(&path, dir, &expand) } else { windows_path_without(&path, dir, &expand) };
    let Some(next) = next else {
        return Ok(format!("{dir} {} on the user PATH", if present { "was already" } else { "was not" }));
    };
    let data: Vec<u8> = next.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect();
    let mut key = HKEY::default();
    let status = unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, w!("Environment"), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut key, None) };
    if status.0 != 0 { return Err(format!("the user environment could not be opened ({})", status.0)); }
    let status = unsafe {
        let status = RegSetValueExW(key, w!("Path"), None, kind, Some(&data));
        let _ = RegCloseKey(key);
        status
    };
    if status.0 != 0 { return Err(format!("the user PATH could not be written ({})", status.0)); }
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(w!("Environment").as_ptr() as isize), SMTO_ABORTIFHUNG, 5000, None);
    }
    Ok(format!("{dir} {} the user PATH", if present { "was added to the end of" } else { "was removed from" }))
}

/// On macOS, put this bundle's `bin` folder last on PATH in the login shell's startup files, once
/// per app location. A copy on a disk image, in Downloads or translocated waits until it runs from
/// where it stays. A recorded location is never written again, so a line the person deletes stays
/// deleted. The updater replaces the bundle at the same path, so the line keeps working.
#[cfg(all(target_os = "macos", feature = "desktop"))]
pub fn ensure_on_shell_path(app: &tauri::AppHandle) -> Result<(), String> {
    use std::{ffi::CStr, fs, io::Write, os::unix::fs::OpenOptionsExt};
    use tauri::Manager;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let Some(bundle) = executable.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app")) else { return Ok(()) };
    let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
    if crate::presence::relocation_source(bundle, &downloads) || bundle.components().any(|part| part.as_os_str() == "AppTranslocation") {
        return Ok(());
    }
    let bin = bundle.join("Contents").join("Resources").join("bin");
    if !bin.join("cotal").is_file() {
        return Err("This copy of Cotal has no cotal command. Reinstall the complete application.".into());
    }
    let dir = bin.to_str().ok_or("The Cotal app's folder name is not valid Unicode.")?;
    let record = app.path().app_config_dir().map_err(|e| e.to_string())?.join("command-line.json");
    if fs::read(&record).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|value| value["bin"] == dir) { return Ok(()); }
    // The account's login shell, as the bundled CLI reads it (os.userInfo().shell).
    let shell = unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_shell.is_null() { String::new() } else { CStr::from_ptr((*entry).pw_shell).to_string_lossy().into_owned() }
    };
    let home: PathBuf = app.path().home_dir().map_err(|e| e.to_string())?;
    let files = shell_startup_files(&shell, &home, &|file| file.exists())
        .map_err(|reason| format!("{reason} Add {dir} to PATH in your shell's startup file to use cotal in a terminal."))?;
    let line = shell_path_line(&shell, dir);
    for file in &files {
        let current = match fs::read_to_string(file) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(format!("Cotal could not read {} to put its cotal command on PATH: {error}", file.display())),
        };
        if current.lines().any(|existing| existing == line) { continue; }
        let write = || -> std::io::Result<()> {
            fs::create_dir_all(file.parent().unwrap_or(&home))?;
            let mut out = fs::OpenOptions::new().create(true).append(true).mode(0o600).open(file)?;
            let gap = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
            write!(out, "{gap}\n# Added by the Cotal app: its cotal command, after any other cotal on PATH\n{line}\n")
        };
        write().map_err(|error| format!("Cotal could not put its cotal command on PATH in {}: {error}", file.display()))?;
    }
    fs::create_dir_all(record.parent().ok_or("The app's configuration folder is unavailable.")?).map_err(|e| e.to_string())?;
    fs::write(&record, serde_json::json!({ "bin": dir }).to_string()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expand(value: &str) -> String { value.replace("%LOCALAPPDATA%", r"C:\Users\Ada\AppData\Local") }
    const DIR: &str = r"C:\Users\Ada\AppData\Local\Cotal\bin";

    #[test]
    fn windows_path_appends_once_after_every_existing_entry() {
        assert_eq!(windows_path_with(r"%USERPROFILE%\npm;C:\tools", DIR, &expand).as_deref(), Some(r"%USERPROFILE%\npm;C:\tools;C:\Users\Ada\AppData\Local\Cotal\bin"));
        assert_eq!(windows_path_with(r"C:\tools;", DIR, &expand).as_deref(), Some(r"C:\tools;C:\Users\Ada\AppData\Local\Cotal\bin;"));
        assert_eq!(windows_path_with("", DIR, &expand).as_deref(), Some(DIR));
        for present in [r"C:\tools;c:\users\ada\appdata\local\cotal\BIN\", r"%LOCALAPPDATA%\Cotal\bin;C:\tools", DIR] {
            assert_eq!(windows_path_with(present, DIR, &expand), None, "{present}");
        }
    }

    #[test]
    fn windows_path_removes_only_this_installation() {
        assert_eq!(windows_path_without(r"%USERPROFILE%\npm;C:\Users\Ada\AppData\Local\Cotal\bin;C:\tools", DIR, &expand).as_deref(), Some(r"%USERPROFILE%\npm;C:\tools"));
        assert_eq!(windows_path_without(r"C:\tools;%LOCALAPPDATA%\Cotal\bin\", DIR, &expand).as_deref(), Some(r"C:\tools"));
        assert_eq!(windows_path_without(DIR, DIR, &expand).as_deref(), Some(""));
        assert_eq!(windows_path_without(r"C:\Program Files\Cotal\bin;C:\tools", DIR, &expand), None);
    }

    #[test]
    fn windows_path_uninstall_gives_back_the_value_exactly() {
        // Windows writes its default user PATH with a trailing semicolon.
        for path in [r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;", r"C:\tools", r"C:\tools;;C:\bin;;", ";", ""] {
            let installed = windows_path_with(path, DIR, &expand).unwrap();
            assert_eq!(windows_path_without(&installed, DIR, &expand).as_deref(), Some(path), "{path}");
        }
    }

    #[test]
    fn shell_startup_files_follow_the_login_shell() {
        let home = PathBuf::from("/Users/ada");
        let none = |_: &Path| false;
        assert_eq!(shell_startup_files("/bin/zsh", &home, &none).unwrap(), vec![home.join(".zshrc")]);
        assert_eq!(shell_startup_files("/bin/bash", &home, &none).unwrap(), vec![home.join(".profile"), home.join(".bashrc")]);
        let login = home.join(".bash_login");
        assert_eq!(shell_startup_files("/opt/homebrew/bin/bash", &home, &|file| file == login).unwrap(), vec![login.clone(), home.join(".bashrc")]);
        assert_eq!(shell_startup_files("/opt/homebrew/bin/fish", &home, &none).unwrap(), vec![home.join(".config/fish/conf.d/cotal-app.fish")]);
        for shell in ["/bin/tcsh", ""] {
            assert!(shell_startup_files(shell, &home, &none).unwrap_err().contains("could not put its cotal command on PATH"), "{shell}");
        }
    }

    #[test]
    fn shell_path_line_appends_the_quoted_folder() {
        assert_eq!(shell_path_line("/bin/zsh", "/Applications/Cotal.app/Contents/Resources/bin"), r#"export PATH="$PATH:/Applications/Cotal.app/Contents/Resources/bin""#);
        assert_eq!(shell_path_line("/bin/bash", r#"/Users/ada/My "$Apps`\Cotal.app/Contents/Resources/bin"#), r#"export PATH="$PATH:/Users/ada/My \"\$Apps\`\\Cotal.app/Contents/Resources/bin""#);
        assert_eq!(shell_path_line("/usr/local/bin/fish", "/Users/ada/Ada's Apps/Cotal.app/Contents/Resources/bin"), r"fish_add_path --path --append '/Users/ada/Ada\'s Apps/Cotal.app/Contents/Resources/bin'");
    }
}
