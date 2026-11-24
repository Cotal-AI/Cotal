use serde_json::Value;

const PART_UNITS: usize = 8192;
const MAX_UNITS: usize = 8 * 1024 * 1024;
const MAX_PARTS: usize = MAX_UNITS.div_ceil(PART_UNITS - 1);
// Account for JSON escaping and the frame envelopes without relaxing other requests' budgets.
pub(crate) const MAX_SPACES_OUTPUT: usize = 6 * MAX_UNITS + 128 * (MAX_PARTS + 1);
const INVALID: &str = "The daemon client returned an incomplete or invalid spaces response.";

#[derive(Default)]
pub(crate) struct SpacesReply {
    text: String,
    parts: usize,
    units: usize,
}

impl SpacesReply {
    pub(crate) fn push(&mut self, frame: &Value) -> Result<(), String> {
        let text = frame.get("text").and_then(Value::as_str).ok_or(INVALID)?;
        let units = text.encode_utf16().count();
        if frame.get("ok").and_then(Value::as_bool) != Some(true)
            || frame.get("index").and_then(Value::as_u64) != Some(self.parts as u64)
            || units == 0 || units > PART_UNITS
            || self.parts >= MAX_PARTS || self.units + units > MAX_UNITS
        {
            return Err(INVALID.into());
        }
        self.parts += 1;
        self.units += units;
        self.text.push_str(text);
        Ok(())
    }

    pub(crate) fn finish(&self, mut frame: Value) -> Result<Value, String> {
        let stream = frame.get("result").and_then(|r| r.get("kind")).and_then(Value::as_str) == Some("spaces-stream");
        if !stream && self.parts == 0 {
            return Ok(frame);
        }
        if !stream || self.parts == 0 || frame.get("ok").and_then(Value::as_bool) != Some(true)
            || frame["result"]["parts"].as_u64() != Some(self.parts as u64)
        {
            return Err(INVALID.into());
        }
        let result: Value = serde_json::from_str(&self.text).map_err(|_| INVALID)?;
        if result.get("kind").and_then(Value::as_str) != Some("spaces") {
            return Err(INVALID.into());
        }
        frame["result"] = result;
        Ok(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn part(index: u64, text: &str) -> Value { json!({"ok": true, "index": index, "text": text}) }
    fn end(parts: u64) -> Value { json!({"ok": true, "result": {"kind": "spaces-stream", "parts": parts}}) }

    #[test]
    fn completes_only_a_numbered_spaces_stream() {
        assert!(MAX_SPACES_OUTPUT > 4 * 64 * 1024);
        let mut reply = SpacesReply::default();
        assert!(reply.finish(end(0)).is_err());
        assert!(reply.push(&part(1, "missing first")).is_err());
        reply.push(&part(0, r#"{"kind":"spaces","spaces":["#)).unwrap();
        assert!(reply.finish(end(2)).is_err());
        assert!(reply.push(&part(0, "duplicate")).is_err());
        reply.push(&part(1, r#""🚀"]}"#)).unwrap();
        assert_eq!(reply.finish(end(2)).unwrap()["result"]["spaces"], json!(["🚀"]));
    }

    #[test]
    fn rejects_oversized_parts_and_incomplete_results() {
        let mut reply = SpacesReply::default();
        assert!(reply.push(&part(0, &"🚀".repeat(PART_UNITS / 2 + 1))).is_err());
        let single = json!({"ok": true, "result": {"kind": "spaces"}});
        assert_eq!(reply.finish(single.clone()).unwrap(), single);
        reply.push(&part(0, "not JSON")).unwrap();
        assert!(reply.finish(single).is_err());
        assert!(reply.finish(end(1)).is_err());
    }
}
