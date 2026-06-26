/**
 * Windows launch smoke (no NATS, no test runner) — run with: pnpm smoke:windows
 *
 * Guards the two seams a POSIX-only build silently breaks on Windows:
 *   1. controlSocketPath → a `\\.\pipe\` named pipe on win32 (Node has no filesystem AF_UNIX
 *      socket there; the prior `<tmp>/*.sock` path fails `listen` with EACCES). Exercises the REAL
 *      startControlServer + a net client round-trip over it — the MCP-server ⇄ hook control plane.
 *   2. resolveOnPath → a bare `claude`/`opencode` resolves to its `.cmd` shim, and the REAL pty
 *      runtime launches that resolved path. node-pty can't launch a bare `.cmd` ("File not found"),
 *      which is why the manager now hands it the resolved command.
 *
 * Cross-platform: the round-trip + resolution run everywhere; win32-only assertions are skipped
 * (logged) off Windows. A throwaway shim stands in for the agent CLI, so no claude/mesh is needed.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { connect } from "node:net";
import { controlSocketPath, startControlServer } from "@cotal-ai/connector-core";
import type { MeshAgent } from "@cotal-ai/connector-core";
import { resolveOnPath } from "../src/bin-path.js";
import { createRuntime } from "../src/index.js";

const isWin = process.platform === "win32";
let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

// --- Fix 1: control endpoint is a real, usable channel on this OS ---------------------------------
function roundTrip(path: string): Promise<string> {
  return new Promise((resolve) => {
    const server = startControlServer({} as MeshAgent, path, async () => ({ pong: true }));
    const done = (v: string): void => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    server.on("error", (e) => done(`server-error:${(e as Error).message}`));
    server.on("listening", () => {
      const c = connect(path);
      let buf = "";
      c.setEncoding("utf8");
      c.on("connect", () => c.write("{}\n"));
      c.on("data", (d) => {
        buf += d;
        if (buf.includes("\n")) {
          c.end();
          done(buf.trim());
        }
      });
      c.on("error", (e) => done(`client-error:${(e as Error).message}`));
    });
    setTimeout(() => done("timeout"), 4000);
  });
}

{
  const path = controlSocketPath("smoke space", "agent/one");
  if (isWin) check("controlSocketPath is a \\\\.\\pipe\\ name on win32", path.startsWith("\\\\.\\pipe\\"));
  else check("controlSocketPath is a <tmp>/*.sock path on POSIX", path.endsWith(".sock"));
  const reply = await roundTrip(path);
  check(`control plane round-trips over the real endpoint (got: ${reply})`, reply === '{"pong":true}');
}

// --- Fix 2: a bare agent command resolves, and the pty runtime launches the resolved path ---------
function launch(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let h: ReturnType<ReturnType<typeof createRuntime>["spawn"]>;
    try {
      h = createRuntime("pty").spawn("winsmoke", { command, args: [], env }, cwd);
    } catch (e) {
      reject(e as Error); // node-pty throws synchronously on an unresolvable command
      return;
    }
    const sess = h.attach();
    let buf = "";
    sess.onData((b) => {
      buf += b.toString("utf8");
    });
    sess.onExit(() => resolve(buf));
    setTimeout(() => {
      try {
        h.stop({ graceful: false });
      } catch {
        /* gone */
      }
      resolve(buf);
    }, 5000);
  });
}

{
  const dir = mkdtempSync(join(tmpdir(), "cotal-winsmoke-"));
  const base = "cotalwinshim";
  let shim: string;
  if (isWin) {
    shim = join(dir, `${base}.cmd`);
    writeFileSync(shim, "@echo COTAL_SHIM_OK\r\n");
  } else {
    shim = join(dir, base);
    writeFileSync(shim, "#!/bin/sh\necho COTAL_SHIM_OK\n", { mode: 0o755 });
  }
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${prevPath ?? ""}`;

  const resolved = resolveOnPath(base);
  check("resolveOnPath finds a bare agent-shim name on PATH", resolved !== null);
  if (isWin) check("resolveOnPath returns the .cmd shim on win32", (resolved ?? "").toLowerCase().endsWith(".cmd"));

  const env = { ...process.env };
  const ranResolved = await launch(resolved ?? base, env, dir).catch((e) => `THREW:${(e as Error).message}`);
  check("pty runtime launches the RESOLVED agent command", ranResolved.includes("COTAL_SHIM_OK"));

  // The fix lives in the pty runtime: a connector hands it a bare `command: "claude"`, and on win32
  // it resolves the PATHEXT shim itself before node-pty (which can't load a bare `.cmd`) — so a bare
  // agent-shim name launches. On POSIX node-pty's own exec resolves the name via PATH.
  const ranBare = await launch(base, env, dir).catch((e) => `THREW:${(e as Error).message}`);
  check("pty runtime launches a bare agent-shim name (win32 resolves it internally)", ranBare.includes("COTAL_SHIM_OK"));
  process.env.PATH = prevPath;
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
