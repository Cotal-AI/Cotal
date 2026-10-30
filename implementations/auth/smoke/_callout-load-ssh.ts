/** Refuse missing, multiple, or non-loopback listeners in an actual ss socket-table observation. */
export function assertLoopbackListener(out: string, port: number, host: string): void {
  const listeners = out.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s+/)[3]);
  if (listeners.length !== 1 || listeners[0] !== `127.0.0.1:${port}`)
    throw new Error(`callout-load: generator ${host} allocated an unsafe SSH listener for port ${port}: ${JSON.stringify(listeners)}`);
}

/** Resolve tools through the login shell's PATH, then drop its ambient credentials before the job. */
export function remoteJobCommand(dir: string, command: string): string {
  const quotedDir = `'${dir.replace(/'/g, `'\\''`)}'`;
  return `cd ${quotedDir} && exec env -i PATH="$PATH" HOME="$HOME" DO_NOT_TRACK=1 COTAL_TELEMETRY=off ${command}`;
}
