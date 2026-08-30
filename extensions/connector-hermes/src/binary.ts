/** The exact `uv` executable resolved by manager boot. A bare fallback remains for library
 * compositions that do not run the installed-extension inventory. */
export function hermesUvCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.COTAL_HERMES_UV_BIN?.trim() || "uv";
}
