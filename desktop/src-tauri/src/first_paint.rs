#[derive(Default)]
pub struct FirstPaint {
    ready: bool,
    requested: bool,
}

#[derive(Debug, PartialEq)]
pub enum ShowAction { Wait, StartTimer, Show }

impl FirstPaint {
    pub fn request(&mut self) -> ShowAction {
        if self.ready { return ShowAction::Show; }
        if self.requested { return ShowAction::Wait; }
        self.requested = true;
        ShowAction::StartTimer
    }

    pub fn painted(&mut self) -> ShowAction {
        if self.ready { return ShowAction::Wait; }
        self.ready = true;
        if self.requested { ShowAction::Show } else { ShowAction::Wait }
    }

    pub fn timeout(&mut self) -> ShowAction {
        if self.ready || !self.requested { return ShowAction::Wait; }
        self.ready = true;
        ShowAction::Show
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requested_before_ready() {
        let mut state = FirstPaint::default();
        assert_eq!(state.request(), ShowAction::StartTimer);
        assert_eq!(state.request(), ShowAction::Wait);
        assert_eq!(state.painted(), ShowAction::Show);
        assert_eq!(state.timeout(), ShowAction::Wait);
        assert_eq!(state.request(), ShowAction::Show);
    }
    #[test]
    fn ready_before_requested_and_background_start() {
        let mut state = FirstPaint::default();
        assert_eq!(state.timeout(), ShowAction::Wait);
        assert_eq!(state.painted(), ShowAction::Wait);
        assert_eq!(state.painted(), ShowAction::Wait);
        assert_eq!(state.request(), ShowAction::Show);
    }
    #[test]
    fn timeout_and_late_repeated_ready() {
        let mut state = FirstPaint::default();
        assert_eq!(state.request(), ShowAction::StartTimer);
        assert_eq!(state.timeout(), ShowAction::Show);
        assert_eq!(state.timeout(), ShowAction::Wait);
        assert_eq!(state.painted(), ShowAction::Wait);
        assert_eq!(state.request(), ShowAction::Show);
    }
}
