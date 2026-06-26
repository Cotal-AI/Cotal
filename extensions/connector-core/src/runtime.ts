import { tmpdir } from "node:os";
import { join } from "node:path";

const ILLEGAL = /[^A-Za-z0-9_-]/g;

function tok(s: string): string {
  const t = s.trim().replace(ILLEGAL, "_");
  return t.length ? t.slice(0, 40) : "_";
}

/**
 * Deterministic path to a connector's local control endpoint. Both the long-lived
 * MCP server (which listens) and its short-lived hooks (which connect) compute
 * this from the SAME identity, so they always agree without a discovery step.
 *
 * Windows has no filesystem (AF_UNIX) sockets: Node's `net` server/client treat a
 * pipe path as a named pipe in the `\\.\pipe\` namespace (off-disk, auto-removed
 * when the last handle closes — so `control.ts`'s stale-file unlink is correctly a
 * no-op there). `tok` keeps the id within `[A-Za-z0-9_-]`, always a valid pipe name.
 * On POSIX, a real socket under the temp dir.
 */
export function controlSocketPath(space: string, name: string): string {
  const id = `cotal-${tok(space)}-${tok(name)}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}
