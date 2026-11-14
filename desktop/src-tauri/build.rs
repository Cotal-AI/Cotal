fn main() {
    println!("cargo:rustc-check-cfg=cfg(cotal_updater)");
    for key in ["COTAL_UPDATER_PUBLIC_KEY", "COTAL_UPDATER_TEST_ENDPOINT", "COTAL_UPDATER_INSECURE"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let test = std::env::var_os("CARGO_FEATURE_UPDATER_E2E").is_some();
    let endpoint = std::env::var("COTAL_UPDATER_TEST_ENDPOINT").ok();
    let insecure = std::env::var_os("COTAL_UPDATER_INSECURE").is_some();
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    assert!(!release || (!test && endpoint.is_none() && !insecure), "Release builds refuse updater test features, endpoints and insecure transport inputs");
    assert!(!insecure, "Updater insecure transport input is unsupported");
    assert!(test || endpoint.is_none(), "A test endpoint requires updater-e2e debug builds");
    if let Some(endpoint) = endpoint {
        let rest = endpoint.strip_prefix("http://127.0.0.1:").expect("The updater test endpoint must use literal local loopback");
        let (port, path) = rest.split_once('/').expect("The updater test endpoint needs a manifest path");
        assert!(port.parse::<u16>().is_ok_and(|port| port != 0) && !path.is_empty() && !path.contains(['\r', '\n', '\0', '@', '#', '?']), "The updater test endpoint must use a local port and fixed manifest path");
        println!("cargo:rustc-env=COTAL_UPDATER_TEST_ENDPOINT={endpoint}");
    }
    if let Ok(key) = std::env::var("COTAL_UPDATER_PUBLIC_KEY") {
        assert!(!key.trim().is_empty(), "COTAL_UPDATER_PUBLIC_KEY is empty; omit it for an installer-only build");
        println!("cargo:rustc-cfg=cotal_updater");
        println!("cargo:rustc-env=COTAL_UPDATER_PUBLIC_KEY={key}");
    }
    #[cfg(feature = "desktop")]
    tauri_build::build()
}
