import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const plain = new Set(["registry", "proxy", "https-proxy", "noproxy", "cafile", "ca", "strict-ssl"]);
const scoped = /^@[a-z\d][a-z\d_.-]*:registry$/i;
const auth = /^\/\/[^\s@?#]+:(?:_authToken|_auth|_password|username|certfile|keyfile)$/;
const limit = 1024 * 1024;
const minimumSecretLength = 8;

function readConfig(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return;
    const data = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < data.length) {
      const count = readSync(fd, data, used, data.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used <= stat.size) return data.toString("utf8", 0, used);
  } finally { closeSync(fd); }
}

// npmrc values are INI assignments. Keep the original value syntax for npm to parse and expand.
function decode(value: string): string {
  value = value.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return (/^(?:\\.|[^\\;#])*\\?/.exec(value)?.[0] ?? "").replace(/\\([\\;#])/g, "$1").trim();
}

function reachability(source: string): [string, string][] {
  const result: [string, string][] = [];
  for (const line of source.split(/[\r\n]+/)) {
    if (/^\s*[;#]/.test(line)) continue;
    // npm treats everything after a section header as a section member rather than a top-level key.
    if (/^\[[^\]]*\]\s*$/.test(line)) break;
    const match = /^([^=]+?)(?:=(.*))?$/.exec(line);
    if (!match) continue;
    const key = decode(match[1]!);
    if (plain.has(key) || key === "ca[]" || key === "noproxy[]" || scoped.test(key) || auth.test(key)) {
      // Reject control bytes and dynamic keys. npm can interpolate values but cannot change this key set.
      if (!/[\x00-\x1f\x7f$;#=]/.test(key)) result.push([key, match[2] ?? "true"]);
    }
  }
  return result;
}

function expanded(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g, (original, slash: string, key: string, optional?: string) =>
    slash.length % 2 ? original.slice((slash.length + 1) / 2) : slash.slice(slash.length / 2) + (env[key] ?? (optional ? "" : `\${${key}}`)));
}

function secrets(entries: [string, string][], env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  const add = (value: string) => {
    if (value.length < minimumSecretLength) return;
    for (const variant of [value, JSON.stringify(value).slice(1, -1)]) values.add(variant);
    try { values.add(encodeURIComponent(value)); values.add(decodeURIComponent(value)); } catch { /* Keep the literal value. */ }
  };
  for (const [key, raw] of entries) {
    const value = expanded(decode(raw), env);
    if (/:(?:_authToken|_auth|_password)$/.test(key) && auth.test(key)) {
      add(value);
      if (key.endsWith(":_password") || key.endsWith(":_auth")) {
        const decoded = Buffer.from(value, "base64").toString();
        add(decoded);
        if (key.endsWith(":_auth") && decoded.includes(":")) add(decoded.slice(decoded.indexOf(":") + 1));
      }
    } else if (key === "registry" || scoped.test(key) || key === "proxy" || key === "https-proxy") {
      try {
        const url = new URL(value);
        add(url.password);
        for (const [, param] of url.searchParams) add(param);
      } catch { add(value); }
    }
  }
  return [...values].filter(value => value.length >= minimumSecretLength).sort((a, b) => b.length - a.length);
}

function redact(values: string[]): (output: string) => string {
  return output => {
    // A URL identifies its password even when it is too short for a substring match.
    output = output.replace(/(https?:\/\/[^\s/@:]+:)[^\s/@]+@/gi, "$1[redacted]@");
    for (const value of values) output = output.replaceAll(value, "[redacted]");
    return output;
  };
}

/** The Windows npm worker scrubs output before it reaches the native job's log. */
export function scrubProjectedNpmrc(file: string, env: NodeJS.ProcessEnv): (output: string) => string {
  return redact(secrets(reachability(readConfig(file) ?? ""), env));
}

function removeOnInterrupt(remove: () => void): () => void {
  const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  const dispose = () => {
    for (const [signal, listener] of handlers) process.off(signal, listener);
    remove();
  };
  // Existing command handlers own cancellation and their call still disposes in finally.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    if (process.listenerCount(signal)) continue;
    const listener = () => {
      if (process.listenerCount(signal) > 1) return;
      try { dispose(); } catch { /* A scratch cleanup error cannot change the exit signal. */ }
      process.kill(process.pid, signal);
    };
    handlers.set(signal, listener);
    process.prependListener(signal, listener);
  }
  return dispose;
}

export function privateNpmrc(source: string, scratch: string, env: NodeJS.ProcessEnv) {
  const entries = reachability(readConfig(source) ?? "");
  if (!entries.length) return;
  const dir = mkdtempSync(join(scratch, "cotal-npmrc-"));
  const file = join(dir, "npmrc");
  const dispose = removeOnInterrupt(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  try {
    writeFileSync(file, entries.map(([key, raw]) => `${key}=${raw}\n`).join(""), { flag: "wx", mode: 0o600 });
    return { file, dispose, scrub: redact(secrets(entries, env)) };
  } catch (error) { dispose(); throw error; }
}
