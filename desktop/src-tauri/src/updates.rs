use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: &'static str,
    pub version: Option<String>,
    pub reason: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            phase: "checking",
            version: None,
            reason: None,
            downloaded: 0,
            total: None,
        }
    }
}

/// Native installation admission is exclusive with every app mutation.
#[derive(Default)]
pub struct Admission {
    operations: usize,
    installing: bool,
}
impl Admission {
    pub fn begin_operation(&mut self) -> Result<(), &'static str> {
        if self.installing {
            return Err("Cotal is applying an update. Wait for it to reopen.");
        }
        self.operations += 1;
        Ok(())
    }
    pub fn end_operation(&mut self) {
        self.operations = self.operations.saturating_sub(1);
    }
    pub fn begin_install(&mut self) -> Result<(), &'static str> {
        if self.installing || self.operations != 0 {
            return Err("Waiting for the current operation to finish.");
        }
        self.installing = true;
        Ok(())
    }
    pub fn end_install(&mut self) {
        self.installing = false;
    }
}

#[derive(Default)]
pub struct UpdateAdmission(pub Mutex<Admission>);

#[cfg(feature = "desktop")]
pub struct OperationGuard(tauri::AppHandle);
#[cfg(feature = "desktop")]
impl OperationGuard {
    pub fn acquire(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager;
        app.state::<UpdateAdmission>()
            .0
            .lock()
            .map_err(|_| "Update admission is unavailable.")?
            .begin_operation()
            .map_err(str::to_owned)?;
        Ok(Self(app.clone()))
    }
}
#[cfg(feature = "desktop")]
impl Drop for OperationGuard {
    fn drop(&mut self) {
        use tauri::Manager;
        if let Ok(mut admission) = self.0.state::<UpdateAdmission>().0.lock() {
            admission.end_operation();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_excludes_mutations_and_waits_for_every_operation() {
        let mut gate = Admission::default();
        gate.begin_operation().unwrap();
        gate.begin_operation().unwrap();
        assert!(gate.begin_install().is_err());
        gate.end_operation();
        assert!(gate.begin_install().is_err());
        gate.end_operation();
        gate.begin_install().unwrap();
        assert!(gate.begin_operation().is_err());
        assert!(gate.begin_install().is_err());
        gate.end_install();
        gate.begin_operation().unwrap();
    }
}
