use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State {
    requests: usize,
    replacing: bool,
    show_requested: bool,
    quit_requested: bool,
    finishing: bool,
}

/// Coordinates this app's own work only. It never fences daemon or Manager activity.
#[derive(Clone, Default)]
pub struct Activity(Arc<Mutex<State>>);
pub struct Request(Activity);
pub struct Replacement(Activity);

impl Activity {
    pub fn request(&self) -> Result<Request, String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        if state.replacing { return Err("Cotal is finishing an update. Wait for it to complete.".into()); }
        state.requests += 1;
        Ok(Request(self.clone()))
    }

    /// Stop new app work first. Existing requests are allowed to drain under a bounded caller wait.
    pub fn replace(&self) -> Result<Replacement, String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        if state.replacing { return Err("An app update is already finishing.".into()); }
        state.replacing = true;
        Ok(Replacement(self.clone()))
    }
    pub fn drained(&self) -> Result<bool, String> {
        Ok(self.0.lock().map_err(|_| "App activity is unavailable.")?.requests == 0)
    }
    pub fn show(&self, show: impl FnOnce()) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        if state.replacing { state.show_requested = true; } else { show(); }
        Ok(())
    }
    pub fn request_exit(&self) -> bool {
        let Ok(mut state) = self.0.lock() else { return false; };
        if state.replacing && !state.finishing { state.quit_requested = true; return false; }
        true
    }
    /// Returns whether the person asked to quit. That intent wins over relaunch or reopen.
    pub fn finish(&self) -> Result<bool, String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        if !state.replacing { return Err("No replacement owns this completion.".into()); }
        state.finishing = true;
        Ok(state.quit_requested)
    }
    pub fn take_show_request(&self) -> Result<bool, String> {
        let mut state = self.0.lock().map_err(|_| "App activity is unavailable.")?;
        Ok(std::mem::take(&mut state.show_requested))
    }
}
impl Drop for Request {
    fn drop(&mut self) { if let Ok(mut state) = self.0.0.lock() { state.requests -= 1; } }
}
impl Drop for Replacement {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.0.lock() { state.replacing = false; state.finishing = false; state.quit_requested = false; }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_blocks_new_work_and_drains_existing_requests() {
        let activity = Activity::default();
        let first = activity.request().unwrap();
        let second = activity.request().unwrap();
        let replacement = activity.replace().unwrap();
        assert!(activity.request().is_err());
        assert!(!activity.drained().unwrap());
        drop(first);
        assert!(!activity.drained().unwrap());
        drop(second);
        assert!(activity.drained().unwrap());
        assert!(activity.replace().is_err());
        drop(replacement);
        assert!(activity.request().is_ok());
    }
    #[test]
    fn remembered_quit_wins_but_download_has_no_admission() {
        let activity = Activity::default();
        assert!(activity.request_exit(), "download does not take replacement admission");
        let replacement = activity.replace().unwrap();
        assert!(!activity.request_exit());
        activity.show(|| panic!("must not show old files during installation")).unwrap();
        assert!(activity.take_show_request().unwrap());
        assert!(activity.finish().unwrap(), "finish must exit rather than restart");
        assert!(activity.request_exit());
        drop(replacement);
        let replacement = activity.replace().unwrap();
        assert!(!activity.finish().unwrap());
        drop(replacement);
    }
}
