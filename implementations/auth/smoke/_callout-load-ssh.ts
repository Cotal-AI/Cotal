/** Refuse missing, multiple, or non-loopback listeners in an actual ss socket-table observation. */
export function assertLoopbackListener(out: string, port: number, host: string): void {
  const listeners = out.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s+/)[3]);
  if (listeners.length !== 1 || listeners[0] !== `127.0.0.1:${port}`)
    throw new Error(`callout-load: generator ${host} allocated an unsafe SSH listener for port ${port}: ${JSON.stringify(listeners)}`);
}

/** Drop ambient credentials before the Node job. An explicit home belongs to the caller and is
 *  never created or removed here; its existing tmp directory keeps runtime caches in the same root. */
export function remoteJobCommand(dir: string, command: string, launchPrefix = "", home?: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  if (home !== undefined && (!home.startsWith("/") || home.includes("\0")))
    throw new Error("callout-load: --load-home must be an absolute path without NUL");
  const jobEnv = home === undefined ? 'HOME="$HOME"'
    : `HOME=${quote(home)} TMPDIR=${quote(`${home}/tmp`)} COTAL_HOME=${quote(home)}`;
  const directories = home === undefined ? "" : `test -d ${quote(home)} && test -d ${quote(`${home}/tmp`)} && `;
  return `cd ${quote(dir)} && ${directories}exec ${launchPrefix ? `${launchPrefix} ` : ""}env -i PATH="$PATH" ${jobEnv} DO_NOT_TRACK=1 COTAL_TELEMETRY=off ${command}`;
}
