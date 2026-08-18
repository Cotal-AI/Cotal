/**
 * Hermes lifecycle-hook control relay, across the language boundary - the cell for a defect the
 * TypeScript cells structurally could not see.
 *
 * WHAT WENT WRONG, and why nothing caught it. When the control token moved out of the seat
 * environment and into the launch-material file, every TypeScript consumer was updated and proved.
 * The hermes lifecycle hooks are PYTHON (`plugin/cotal/hooks.py`), they read
 * `COTAL_CONTROL_TOKEN` straight out of `os.environ`, and they return early and silently when it is
 * absent. The launcher stopped exporting it. So every presence relay became a no-op: the seat
 * joined, the sidecar and the bridge kept working, and presence sat on its first value forever. No
 * error, no exit, no failing assertion anywhere in the tree, because the seat-env-scope cell reads
 * launch specs, its A3 leg SKIPS the hermes control token (this connector mints its endpoint inside
 * its own launcher, so `buildLaunch` returns none), and no suite loads the Python plugin at all.
 *
 * A reviewer found it by reading. This is the assertion that would have found it, and the reason it
 * has to cross the language boundary: both halves of that contract have to be checked in the
 * languages that actually implement them, or a change to one side keeps passing against a model of
 * the other.
 *
 *   H1  a managed launch (socket path in the env, token in the launch material only) relays, and
 *       the frame carries the token the manager holds
 *   H2  standalone mode (token exported directly, no material) still relays - the fallback is a
 *       supported path, not a deprecated one
 *   H3  a socket with NO resolvable token relays NOTHING and says so on stderr, rather than
 *       returning silently the way the defect did
 *   H4  a material file readable beyond its owner yields no token, matching the TypeScript reader
 *
 * H3 is the one that turns this from a happy-path test into a cell. The defect's whole character was
 * that it produced no output; an assertion that only checks the good path would have gone green
 * against the broken code the moment someone re-exported the variable by accident.
 *
 * Run: `pnpm smoke:hermes-hooks-control`
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("✓ hermes hooks-control smoke skipped on Windows (the Hermes connector is Unix-only)");
  process.exit(0);
}

/** The Python interpreter this suite drives. Absent → REFUSE rather than skip: the hermes connector
 *  ships a Python plugin, so a tree that cannot run Python cannot claim this contract holds. A skip
 *  here would be a green that checked nothing, which is the exact shape of the defect above. */
const PY = process.env.COTAL_PYTHON?.trim() || "python3";
const probe = spawnSync(PY, ["--version"], { encoding: "utf8" });
assert.equal(probe.status, 0, `hermes hooks-control smoke needs ${PY} on PATH (the connector ships a Python plugin)`);

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const work = mkdtempSync(join(tmpdir(), "cotal-hermes-hooks-"));

/** Start a one-shot control listener and return the frames it receives. Deliberately raw `node:net`
 *  rather than the real control server: what is under test is whether the hook can PRODUCE an
 *  authenticated frame at all, and a server that validates would report "no frame" and "wrong token"
 *  as the same silence. */
function listener(path: string): { frames: string[]; close: () => void } {
  const frames: string[] = [];
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        frames.push(buf.trim());
        sock.end("{}\n");
      }
    });
    sock.on("error", () => {});
  });
  server.listen(path);
  return { frames, close: () => server.close() };
}

/** Fire ONE real hook through the real `hooks.py`, with exactly the env given (never the ambient
 *  one, which on a developer or agent box carries a live identity of its own). */
function fireHook(env: Record<string, string>): { status: number | null; stderr: string } {
  const r = spawnSync(PY, ["-c", "import cotal.hooks as h; h.relay('SessionStart')"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONPATH: PLUGIN_DIR, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

/** Wait for the listener to have accepted a frame (the hook is a separate process). */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
}

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ FAIL: ${name}`, detail === undefined ? "" : detail);
  }
};

const TOKEN = "material-side-token-0123456789";

// H1 - managed launch: socket path in the env, token ONLY in the launch material.
{
  const sock = join(work, "h1.sock");
  const material = join(work, "h1.json");
  writeFileSync(material, JSON.stringify({ controlToken: TOKEN, servers: "nats://127.0.0.1:1" }), { mode: 0o600 });
  chmodSync(material, 0o600);
  const l = listener(sock);
  const run = fireHook({ COTAL_CONTROL_SOCKET: sock, COTAL_LAUNCH_MATERIAL: material });
  await settle();
  l.close();
  check("H1: the hook exited cleanly", run.status === 0, run.stderr);
  check("H1: a managed launch relays one frame with the token from the launch material", l.frames.length === 1 && JSON.parse(l.frames[0] ?? "{}").token === TOKEN, l.frames.length);
  check(
    "H1: and the frame carries the lifecycle event the hook was fired for",
    JSON.parse(l.frames[0] ?? "{}")?.event?.hook_event_name === "SessionStart",
    l.frames[0],
  );
}

// H2 - standalone: token exported directly, no material file. Still a supported path.
{
  const sock = join(work, "h2.sock");
  const l = listener(sock);
  const run = fireHook({ COTAL_CONTROL_SOCKET: sock, COTAL_CONTROL_TOKEN: "standalone-token-abc" });
  await settle();
  l.close();
  check("H2: standalone mode still relays with a directly exported token", run.status === 0 && l.frames.length === 1 && JSON.parse(l.frames[0] ?? "{}").token === "standalone-token-abc", l.frames.length);
}

// H3 - the defect: a control socket with no resolvable token anywhere.
{
  const sock = join(work, "h3.sock");
  const l = listener(sock);
  const run = fireHook({ COTAL_CONTROL_SOCKET: sock });
  await settle();
  l.close();
  check("H3: no resolvable token relays NOTHING", l.frames.length === 0, l.frames);
  check(
    "H3: and it says so on stderr instead of returning silently (this is the whole defect)",
    /presence relays are disabled/.test(run.stderr),
    run.stderr,
  );
}

// H4 - a material file other local users can read is not a source of a control token.
{
  const sock = join(work, "h4.sock");
  const material = join(work, "h4.json");
  writeFileSync(material, JSON.stringify({ controlToken: TOKEN }), { mode: 0o600 });
  chmodSync(material, 0o644);
  const l = listener(sock);
  const run = fireHook({ COTAL_CONTROL_SOCKET: sock, COTAL_LAUNCH_MATERIAL: material });
  await settle();
  l.close();
  check("H4: a world-readable material file yields no token, so nothing is relayed", l.frames.length === 0, l.frames);
  check("H4: and that is reported, not silent", /presence relays are disabled/.test(run.stderr), run.stderr);
}

if (failed) {
  console.log(`\nHERMES HOOKS-CONTROL SMOKE FAILED ❌  (${failed} failed)`);
  process.exit(1);
}
console.log("\nHERMES HOOKS-CONTROL SMOKE OK ✅");
