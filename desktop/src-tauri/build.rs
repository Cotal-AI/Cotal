fn main() {
    println!("cargo:rustc-check-cfg=cfg(cotal_updater)");
    println!("cargo:rerun-if-env-changed=COTAL_UPDATER_PUBLIC_KEY");
    if let Ok(key) = std::env::var("COTAL_UPDATER_PUBLIC_KEY") {
        assert!(!key.trim().is_empty(), "COTAL_UPDATER_PUBLIC_KEY is empty; omit it for an installer-only build");
        println!("cargo:rustc-cfg=cotal_updater");
        println!("cargo:rustc-env=COTAL_UPDATER_PUBLIC_KEY={key}");
    }
    #[cfg(feature = "desktop")]
    tauri_build::build()
}
