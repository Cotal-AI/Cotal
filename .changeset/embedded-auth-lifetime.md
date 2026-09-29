---
"@cotal-ai/auth": patch
---

Add `startAuthService`, an account-scoped auth-service context with readiness, drain and close that installs no process signal handlers, never exits the process and never selects a root from the working directory. `openAuthAuthorityPlane` now takes its local manager identity as an explicit `localManager` input instead of reading it from the cwd-selected root.
