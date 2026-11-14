use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State {
    requests: usize,
    replacing: bool,
    show_requested: bool,
    restart_committed: bool,
}

/// Coordinates this app's own work only. It never fences daemon or Manager activity.
#[derive(Clone, Default)]
pub struct Activity(Arc<Mutex<State>>);

pub struct Request(Activity);
pub struct Replacement(Activity);

impl Activity {
    pub fn request(&self) -> Result<Request, String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        if state.replacing { return Err("Cotal is restarting to update. Wait for it to reopen.".into()); }
        state.requests += 1;
        Ok(Request(self.clone()))
    }

    pub fn replace(&self) -> Result<Replacement, String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        if state.replacing || state.requests != 0 {
            return Err("An app operation is still running. The update will wait.".into());
        }
        state.replacing = true;
        Ok(Replacement(self.clone()))
    }

    /// Hold admission through the native show operation, not just through its visibility sample.
    pub fn show(&self, show: impl FnOnce()) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        if state.replacing { state.show_requested = true; } else { show(); }
        Ok(())
    }

    pub fn allow_exit(&self) -> bool {
        self.0.lock().map(|state| !state.replacing || state.restart_committed).unwrap_or(false)
    }

    pub fn restart(&self) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        if !state.replacing { return Err("No replacement owns this restart.".into()); }
        state.restart_committed = true;
        Ok(())
    }

    pub fn take_show_request(&self) -> Result<bool, String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        Ok(std::mem::take(&mut state.show_requested))
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.0.lock() { state.requests -= 1; }
    }
}
impl Drop for Replacement {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.0.lock() { state.replacing = false; state.restart_committed = false; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_excludes_requests_and_defers_show_until_released() {
        let activity = Activity::default();
        let request = activity.request().unwrap();
        assert!(activity.replace().is_err());
        drop(request);
        let replacement = activity.replace().unwrap();
        assert!(activity.request().is_err());
        assert!(!activity.allow_exit());
        activity.restart().unwrap();
        assert!(activity.allow_exit());
        assert!(activity.replace().is_err());
        activity.show(|| panic!("must not show an old window during replacement")).unwrap();
        drop(replacement);
        assert!(activity.take_show_request().unwrap());
        assert!(!activity.take_show_request().unwrap());
        let mut shown = false;
        activity.show(|| shown = true).unwrap();
        assert!(shown);
        assert!(activity.request().is_ok());
    }
    #[test]
    fn all_overlapping_bridge_requests_must_finish() {
        let activity = Activity::default();
        let first = activity.request().unwrap();
        let second = activity.request().unwrap();
        drop(first);
        assert!(activity.replace().is_err());
        drop(second);
        assert!(activity.replace().is_ok());
    }
}
