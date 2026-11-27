import { productEnv, run, tail, waitFor } from './proc.mjs';

// The variables the app hands its bundled CLI (daemon_env_key in desktop/src-tauri/src/lib.rs).
const APP_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'SYSTEMROOT', 'WINDIR',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]);

function appEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => APP_ENV_KEYS.has(key.toUpperCase())));
  return { ...env, DO_NOT_TRACK: '1' };
}

/** Sends one request the way the app's buttons do: one JSON line to `cotal daemon desktop`. */
export async function bridge(app, request, timeout = 150_000) {
  const call = await run(app.node, [app.cli, 'daemon', 'desktop'], { input: `${JSON.stringify(request)}\n`, env: appEnv(), timeout });
  const frames = call.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
  const result = frames.find((frame) => frame?.event === 'result') ?? null;
  return { ok: call.code === 0 && result?.ok !== false && result !== null, ms: call.ms, code: call.code, timedOut: call.timedOut, result, frames: frames.length, stderr: tail(call.stderr, 600) };
}

/** Runs the app's own bundled CLI. */
export function cli(app, args, timeout = 120_000) {
  return run(app.node, [app.cli, ...args], { env: productEnv(), timeout });
}

export async function daemonStatus(app) {
  const call = await cli(app, ['daemon', 'status', '--json'], 60_000);
  try {
    const parsed = JSON.parse(call.stdout);
    return { ok: call.code === 0, status: parsed.result ?? parsed, code: call.code };
  } catch {
    return { ok: false, code: call.code, output: tail(call.stdout || call.stderr, 600) };
  }
}

/** Waits until the background service answers at `version`. */
export function serviceAt(app, version, timeout = 180_000) {
  return waitFor(async () => {
    const read = await daemonStatus(app);
    const at = read.status?.version;
    return { ok: read.ok && at === version, version: at ?? null, running: read.status?.running ?? null, code: read.code };
  }, { timeout, interval: 2000 });
}
