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
 *   H1  a managed launch (socket path in the env, key and version in the launch material only)
 *       relays: the hook proves the key through the control exchange, and the key itself never
 *       crosses the socket
 *   H2  standalone mode (key and version exported directly, no material) still relays - the
 *       fallback is a supported path, not a deprecated one
 *   H3  a socket with NO resolvable key relays NOTHING and says so on stderr, rather than
 *       returning silently the way the defect did
 *   H4  a material file readable beyond its owner yields no key, matching the TypeScript reader
 *   H5  a key without the version this plugin speaks (no version, version 2, a direct key with no
 *       COTAL_CONTROL_VERSION) relays nothing and says so
 *   H6  a stand-in server that does not hold the key, or speaks another version, gets no request
 *       and no key, and the hook says so
 *   H7  a socket in a directory other users can enter is not dialed at all
 *
 * H3 is the one that turns this from a happy-path test into a cell. The defect's whole character was
 * that it produced no output; an assertion that only checks the good path would have gone green
 * against the broken code the moment someone re-exported the variable by accident.
 *
 * Run: `pnpm smoke:hermes-hooks-control`
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlTranscriptMac as mac, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

/** The Python interpreter this suite drives. Absent → REFUSE rather than skip: the hermes connector
 *  ships a Python plugin, so a tree that cannot run Python cannot claim this contract holds. A skip
 *  here would be a green that checked nothing, which is the exact shape of the defect above. */
const PY = process.env.COTAL_PYTHON?.trim() || "python3";
const probe = spawnSync(PY, ["--version"], { encoding: "utf8" });
assert.equal(probe.status, 0, `hermes hooks-control smoke needs ${PY} on PATH (the connector ships a Python plugin)`);

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const work = mkdtempSync(join(tmpdir(), "cotal-hermes-hooks-"));

interface Heard {
  /** Connections accepted. */
  conns: number;
  /** Every byte the hook sent, to check the key never crossed the socket. */
  raw: string;
  /** Each request line, and whether its MAC verified under the listener's key. */
  requests: { proven: boolean; body: string }[];
}

/** Start a control listener that runs the server half of the exchange from the documented transcript
 *  bytes (smoke-kit's `controlTranscriptMac`) rather than the real control server: what is under test
 *  is whether the hook can PRODUCE a proven request at all, and a server that validates would report
 *  "no request" and "wrong key" as the same silence. `key: null` stands in for a server that does not
 *  hold the key; `version` for a server of another release. */
function listener(path: string, key: string | null, version = 1): { heard: Heard; close: () => void } {
  const heard: Heard = { conns: 0, raw: "", requests: [] };
  const server = createServer((sock) => {
    heard.conns++;
    const ns = randomBytes(32).toString("base64url");
    let nc: string | undefined;
    let buf = "";
    sock.on("data", (d) => {
      heard.raw += d.toString();
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (nc === undefined) {
          nc = String((JSON.parse(line) as { nonce?: unknown }).nonce);
          const proof = key ? mac(key, "server", nc, ns) : randomBytes(32).toString("base64url");
          sock.write(JSON.stringify({ v: version, nonce: ns, mac: proof }) + "\n");
          continue;
        }
        const sp = line.indexOf(" ");
        const body = line.slice(sp + 1);
        heard.requests.push({ proven: !!key && line.slice(0, sp) === mac(key, "client", nc, ns, body), body });
        sock.end(`${key ? mac(key, "reply", nc, ns, "{}") : "x"} {}\n`);
      }
    });
    sock.on("error", () => {});
  });
  server.listen(path);
  return { heard, close: () => server.close() };
}

/** Fire ONE real hook through the real `hooks.py`, with exactly the env given (never the ambient
 *  one, which on a developer or agent box carries a live identity of its own). Asynchronous, because
 *  the listener answering the exchange runs in this process and a synchronous spawn would block it. */
async function fireHook(env: Record<string, string>): Promise<{ status: number | null; stderr: string }> {
  const child = spawn(PY, ["-c", "import cotal.hooks as h; h.relay('SessionStart')"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONPATH: PLUGIN_DIR, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const [status] = (await once(child, "exit")) as [number | null];
  return { status, stderr };
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
const event = (h: Heard): unknown => (JSON.parse(h.requests[0]?.body ?? "{}") as { event?: { hook_event_name?: unknown } }).event?.hook_event_name;

/** Write a launch-material file with `fields`, at `mode`. */
function material(name: string, fields: Record<string, unknown>, mode = 0o600): string {
  const path = join(work, name);
  writeFileSync(path, JSON.stringify(fields), { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}

/** Fire one hook at a listener on `name` in the private work directory and collect what it heard. */
async function relayTo(name: string, key: string | null, env: Record<string, string>, version = 1): Promise<{ heard: Heard; run: { status: number | null; stderr: string } }> {
  const sock = join(work, name);
  const l = listener(sock, key, version);
  const run = await fireHook({ COTAL_CONTROL_SOCKET: sock, ...env });
  await settle();
  l.close();
  return { heard: l.heard, run };
}

// H1 - managed launch: socket path in the env, key and version ONLY in the launch material.
{
  const m = material("h1.json", { controlToken: TOKEN, controlVersion: 1, servers: "nats://127.0.0.1:1" });
  const { heard, run } = await relayTo("h1.sock", TOKEN, { COTAL_LAUNCH_MATERIAL: m });
  check("H1: the hook exited cleanly", run.status === 0, run.stderr);
  check("H1: a managed launch relays one request proven with the key from the launch material", heard.requests.length === 1 && heard.requests[0]!.proven, heard.requests);
  check("H1: and the request carries the lifecycle event the hook was fired for", event(heard) === "SessionStart", heard.requests[0]);
  check("H1: and the key itself never crossed the socket", heard.raw.length > 0 && !heard.raw.includes(TOKEN), heard.raw);
}

// H2 - standalone: key and version exported directly, no material file. Still a supported path.
{
  const { heard, run } = await relayTo("h2.sock", "standalone-token-abc", { COTAL_CONTROL_TOKEN: "standalone-token-abc", COTAL_CONTROL_VERSION: "1" });
  check("H2: standalone mode still relays with a directly exported key and version", run.status === 0 && heard.requests.length === 1 && heard.requests[0]!.proven, heard.requests);
}

// H3 - the defect: a control socket with no resolvable key anywhere.
{
  const { heard, run } = await relayTo("h3.sock", TOKEN, {});
  check("H3: no resolvable key relays NOTHING", heard.conns === 0 && heard.requests.length === 0, heard);
  check("H3: and it says so on stderr instead of returning silently (this is the whole defect)", /presence relays are disabled/.test(run.stderr), run.stderr);
}

// H4 - a material file other local users can read is not a source of a control key.
{
  const m = material("h4.json", { controlToken: TOKEN, controlVersion: 1 }, 0o644);
  const { heard, run } = await relayTo("h4.sock", TOKEN, { COTAL_LAUNCH_MATERIAL: m });
  check("H4: a world-readable material file yields no key, so nothing is relayed", heard.conns === 0, heard);
  check("H4: and that is reported, not silent", /presence relays are disabled/.test(run.stderr), run.stderr);
}

// H5 - a key without the version this plugin speaks is refused before any dial, and says so.
for (const [label, env] of [
  ["material with no controlVersion", { COTAL_LAUNCH_MATERIAL: material("h5a.json", { controlToken: TOKEN }) }],
  ["material with controlVersion 2", { COTAL_LAUNCH_MATERIAL: material("h5b.json", { controlToken: TOKEN, controlVersion: 2 }) }],
  ["a direct key with no COTAL_CONTROL_VERSION", { COTAL_CONTROL_TOKEN: TOKEN }],
  ["a direct key with COTAL_CONTROL_VERSION=2", { COTAL_CONTROL_TOKEN: TOKEN, COTAL_CONTROL_VERSION: "2" }],
] as const) {
  const { heard, run } = await relayTo(`h5-${label.length}.sock`, TOKEN, env);
  check(`H5: ${label} relays nothing`, heard.conns === 0, heard);
  check(`H5: ${label} is reported, not silent`, /control protocol version/.test(run.stderr), run.stderr);
}

// H6 - a stand-in on the socket: one without the key, and one of another version.
{
  const m = material("h6.json", { controlToken: TOKEN, controlVersion: 1 });
  const standIn = await relayTo("h6a.sock", null, { COTAL_LAUNCH_MATERIAL: m });
  check("H6: a stand-in without the key gets the hello and no request", standIn.heard.conns === 1 && standIn.heard.requests.length === 0, standIn.heard);
  check("H6: and never sees the key", !standIn.heard.raw.includes(TOKEN), standIn.heard.raw);
  check("H6: and the hook says the socket did not prove itself", /did not prove it holds/.test(standIn.run.stderr), standIn.run.stderr);
  const v2 = await relayTo("h6b.sock", TOKEN, { COTAL_LAUNCH_MATERIAL: m }, 2);
  check("H6: a server answering with version 2 gets no request", v2.heard.conns === 1 && v2.heard.requests.length === 0, v2.heard);
}

// H7 - a socket in a directory other users can enter is not dialed.
{
  const open = join(work, "open");
  mkdirSync(open);
  chmodSync(open, 0o755);
  const m = material("h7.json", { controlToken: TOKEN, controlVersion: 1 });
  const { heard, run } = await relayTo("open/h7.sock", TOKEN, { COTAL_LAUNCH_MATERIAL: m });
  check("H7: a socket in a directory other users can enter is not dialed", heard.conns === 0, heard);
  check("H7: and that is reported, not silent", /not private to this user/.test(run.stderr), run.stderr);
}

if (failed) {
  console.log(`\nHERMES HOOKS-CONTROL SMOKE FAILED ❌  (${failed} failed)`);
  process.exit(1);
}
console.log("\nHERMES HOOKS-CONTROL SMOKE OK ✅");
