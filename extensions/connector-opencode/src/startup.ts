/** OpenCode may recover an npm-install lock for 60s before its first dependency download. */
export const OPENCODE_BOOT_TIMEOUT_MS = 120_000;
/** Let the launcher stop its server and report the boot failure before the manager settles. */
export const OPENCODE_READINESS_TIMEOUT_MS = OPENCODE_BOOT_TIMEOUT_MS + 5_000;
