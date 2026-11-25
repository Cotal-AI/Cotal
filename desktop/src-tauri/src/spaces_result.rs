//! Reassembles the bounded, ordered parts of a single spaces response from the sidecar.
use serde_json::Value;

const MAX_SPACES_BYTES: usize = 8 * 1024 * 1024;
#[cfg(feature = "desktop")]
pub(crate) const MAX_FRAME: usize = 64 * 1024;
#[cfg(feature = "desktop")]
pub(crate) const MAX_SPACES_WIRE_BYTES: usize = 2 * MAX_SPACES_BYTES + 4 * MAX_FRAME;
const ASSEMBLY_ERROR: &str = "The daemon client returned an invalid spaces result.";

#[derive(Default)]
pub(crate) struct SpacesResult {
    bytes: String,
    count: u64,
    id: Option<String>,
}

impl SpacesResult {
    pub(crate) fn push(&mut self, frame: &Value) -> Result<(), String> {
        let data = frame["data"].as_str().filter(|s| !s.is_empty()).ok_or(ASSEMBLY_ERROR)?;
        let id = frame["id"].as_str().filter(|s| !s.is_empty()).ok_or(ASSEMBLY_ERROR)?;
        if frame["index"].as_u64() != Some(self.count)
            || self.id.as_deref().is_some_and(|previous| previous != id)
            || self.bytes.len() + data.len() > MAX_SPACES_BYTES
        {
            return Err(ASSEMBLY_ERROR.into());
        }
        self.id.get_or_insert_with(|| id.to_owned());
        self.bytes.push_str(data);
        self.count += 1;
        Ok(())
    }

    pub(crate) fn finish(&mut self, frame: Value) -> Result<Value, String> {
        if self.count == 0 && frame.get("parts").is_none() { return Ok(frame); }
        if self.count == 0 || frame["parts"].as_u64() != Some(self.count)
            || frame["id"].as_str() != self.id.as_deref()
        {
            return Err(ASSEMBLY_ERROR.into());
        }
        let result: Value = serde_json::from_str(&std::mem::take(&mut self.bytes)).map_err(|_| ASSEMBLY_ERROR)?;
        if result["v"].as_u64() != Some(1) || result["id"].as_str() != self.id.as_deref()
            || result["event"].as_str() != Some("result") || result["ok"].as_bool() != Some(true)
            || result["result"]["kind"].as_str() != Some("spaces")
        {
            return Err(ASSEMBLY_ERROR.into());
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_an_ordinary_result() {
        let result = json!({"v":1,"event":"result","ok":false,"error":{"code":"CATALOG_SYNC_BUSY"}});
        assert_eq!(SpacesResult::default().finish(result.clone()).unwrap(), result);
    }

    #[test]
    fn joins_ordered_parts_without_losing_text() {
        let result = json!({"v":1,"id":"one","event":"result","ok":true,"result":{"kind":"spaces","label":"東京 🌱"}});
        let text = result.to_string();
        let index = text.find("東京").unwrap();
        let mut read = SpacesResult::default();
        read.push(&json!({"id":"one","index":0,"data":&text[..index]})).unwrap();
        read.push(&json!({"id":"one","index":1,"data":&text[index..]})).unwrap();
        assert_eq!(read.finish(json!({"id":"one","parts":2})).unwrap(), result);
    }

    #[test]
    fn refuses_missing_out_of_order_or_mismatched_parts() {
        let mut read = SpacesResult::default();
        assert!(read.finish(json!({"id":"one","parts":2})).is_err());
        assert!(read.push(&json!({"id":"one","index":1,"data":"x"})).is_err());
        read.push(&json!({"id":"one","index":0,"data":"x"})).unwrap();
        assert!(read.push(&json!({"id":"other","index":1,"data":"x"})).is_err());
        assert!(read.finish(json!({"id":"one","parts":2})).is_err());
        assert!(read.finish(json!({"id":"one","parts":1})).is_err());
    }

    #[test]
    fn refuses_assembled_results_over_the_limit() {
        let mut read = SpacesResult { bytes: "x".repeat(MAX_SPACES_BYTES), count: 1, id: Some("one".into()) };
        assert!(read.push(&json!({"id":"one","index":1,"data":"x"})).is_err());
    }
}
