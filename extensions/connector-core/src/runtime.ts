import { tmpdir } from "node:os";
import { join } from "node:path";

const ILLEGAL = /[^A-Za-z0-9_-]/g;

function tok(s: string): string {
  const t = s.trim().replace(ILLEGAL, "_");
  return t.length ? t.slice(0, 40) : "_";
}

/**
 * Deterministic path to a connector's local control socket. Both the long-lived
 * MCP server (which listens) and its short-lived hooks (which connect) compute
 * this from the SAME identity, so they always agree without a discovery step.
 *
 * NOTE: the Windows control plane (a `\\.\pipe\` named pipe — Node has no filesystem
 * AF_UNIX socket there) is deferred to the control-plane stage, where it lands WITH
 * the authenticated endpoint (random token, hashed id, first-frame auth, fatal bind).
 * A deterministic identity-only pipe name is a guessable, squattable, unauthenticated
 * endpoint, so it must not ship ahead of that auth. This stays POSIX-shaped for now.
 */
export function controlSocketPath(space: string, name: string): string {
  return join(tmpdir(), `cotal-${tok(space)}-${tok(name)}.sock`);
}
