//! Passive diagnostics, compiled only into debug E2E builds.
use serde_json::{json, Value};
use std::io::Write;

fn safe_argument(value: &str) -> Value {
    if matches!(value, "--background" | "--daemon-home") {
        return json!({"flag": value});
    }
    // Never serialize an input URL, even after parsing. Only this fixed route is public.
    if value.len() <= 4096 {
        if let Ok(url) = url::Url::parse(value) {
            if url.scheme() == "cotal" && url.host_str() == Some("connect")
                && url.username().is_empty() && url.password().is_none()
                && url.port().is_none() && matches!(url.path(), "" | "/")
            {
                return json!({"url": "cotal://connect", "query": if url.query().is_some() { "redacted" } else { "absent" }, "fragment": if url.fragment().is_some() { "redacted" } else { "absent" }});
            }
        }
    }
    json!({"redacted": true})
}

pub fn receipt(source: &'static str, values: impl IntoIterator<Item = String>) {
    let Some(home) = crate::e2e_trace_home() else { return; };
    let values: Vec<String> = values.into_iter().take(64).collect();
    let probe_shapes: Vec<Value> = values.iter().map(|v| public_probe_argument(v)).collect();
    let values: Vec<Value> = values.into_iter().take(64).map(|v| safe_argument(&v)).collect();
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis());
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(home.join("deep-link-receipts.jsonl")) {
        let _ = writeln!(file, "{}", json!({"source": source, "pid": std::process::id(), "atUnixMs": at, "values": values, "publicProbeShapes": probe_shapes}));
    }
}

fn public_probe_argument(value: &str) -> Value {
    const EXPECTED: &str = "cotal://connect?idp=http%3A%2F%2F127.0.0.1%3A9%2Fapi%2Fauth&space=e2e-public-link";
    let form = if value == EXPECTED { "literal" }
        else if value.strip_prefix("--") == Some(EXPECTED) { "leading-dashes" }
        else if value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) == Some(EXPECTED) { "quoted" }
        else { "other" };
    // No arbitrary argument content enters this additional diagnostic.
    let public_argument = match form {
        "literal" => Some(EXPECTED.to_owned()),
        "leading-dashes" => Some(["--", EXPECTED].concat()),
        "quoted" => Some(["\"", EXPECTED, "\""].concat()),
        _ => None,
    };
    json!({"bytes": value.len(), "publicProbeForm": form, "leadingDashes": value.starts_with("--"), "publicArgument": public_argument})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_probe_matches_only_fixed_forms() {
        let expected = "cotal://connect?idp=http%3A%2F%2F127.0.0.1%3A9%2Fapi%2Fauth&space=e2e-public-link";
        for value in [expected.to_owned(), ["--", expected].concat(), ["\"", expected, "\""].concat()] {
            assert_eq!(public_probe_argument(&value)["publicArgument"], value);
        }
        for value in ["--token=SECRET".to_owned(), [expected, "&token=SECRET"].concat(), "https://private.invalid/SECRET".to_owned()] {
            let diagnostic = public_probe_argument(&value);
            assert!(diagnostic["publicArgument"].is_null());
            assert_eq!(diagnostic["publicProbeForm"], "other");
            assert!(!diagnostic.to_string().contains("SECRET"));
        }
    }
    #[test]
    fn secrets_and_unknown_arguments_fail_closed() {
        for value in ["/private/key", "--token=secret", "cotal://secret/path", "cotal://user:secret@connect", "cotal://connect/private", "https://secret.invalid", "cotal://connect:123"] {
            assert_eq!(safe_argument(value), json!({"redacted": true}));
        }
        assert_eq!(safe_argument("--background"), json!({"flag":"--background"}));
        assert_eq!(safe_argument("cotal://connect?idp=https%3A%2F%2Fu%3Ap%40host%2Fsecret&token=SECRET&space=PRIVATE#SECRET"), json!({"url":"cotal://connect", "query":"redacted", "fragment":"redacted"}));
        assert_eq!(safe_argument("cotal://connect"), json!({"url":"cotal://connect", "query":"absent", "fragment":"absent"}));
    }
}
