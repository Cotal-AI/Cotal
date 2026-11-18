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
 *   H4  a material file readable beyond its owner is refused and says so, matching the TypeScript reader
 *   H5  a key without the version this plugin speaks (no version, version 2, a direct key with no
 *       COTAL_CONTROL_VERSION) relays nothing and says so
 *   H6  a stand-in server that does not hold the key, or speaks another version, gets no request
 *       and no key, and the hook says so
 *   H7  a socket in a directory other users can enter is not dialed at all
 *   H8  a server that holds the key but sends a challenge the TypeScript client refuses (over the
 *       1 KiB cap in one write, a nonce with a trailing newline, a version of `true`, a MAC with a
 *       character outside base64url) gets no request
 *   H9  the key's carriers are read as the TypeScript readers read them: the old COTAL_CONTROL_TOKEN
 *       and controlToken names, a controlVersion of `true`, and a direct key beside a material file
 *       all relay nothing and say why
 *   H10 the standalone bootstrap mints the key and its version together only when the launch carries
 *       neither, and refuses half a pair instead of filling in the other half
 *   H11 the Python client bounds and decodes what a key-holding server sends as the TypeScript client
 *       does: a reply that never ends is refused at 4 KiB, and a challenge or reply that is not UTF-8
 *       is refused
 *   H12 one rule for the key's carriers, run over the same vectors through the TypeScript reader
 *       (`controlFromEnv`) and the Python one (`control_key`): whitespace around a key, a version
 *       that is not exactly 1, a version without a key, null material fields, and a material file
 *       beside any direct material variable
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
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlTranscriptMac as mac, skipSuite } from "@cotal-ai/smoke-kit";
import { controlFromEnv } from "@cotal-ai/connector-core";

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
 *  hold the key; `version` for a server of another release; `challenge` replaces the challenge line
 *  (newline included) for a server that holds the key and sends one the client must refuse. */
function listener(
  path: string,
  key: string | null,
  version: unknown = 1,
  challenge?: (nc: string, ns: string) => string,
): { heard: Heard; close: () => void } {
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
          sock.write(challenge ? challenge(nc, ns) : JSON.stringify({ v: version, nonce: ns, mac: proof }) + "\n");
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
async function relayTo(
  name: string,
  key: string | null,
  env: Record<string, string>,
  version: unknown = 1,
  challenge?: (nc: string, ns: string) => string,
): Promise<{ heard: Heard; run: { status: number | null; stderr: string } }> {
  const sock = join(work, name);
  const l = listener(sock, key, version, challenge);
  const run = await fireHook({ COTAL_CONTROL_SOCKET: sock, ...env });
  await settle();
  l.close();
  return { heard: l.heard, run };
}

// H1 - managed launch: socket path in the env, key and version ONLY in the launch material.
{
  const m = material("h1.json", { controlKey: TOKEN, controlVersion: 1, servers: "nats://127.0.0.1:1" });
  const { heard, run } = await relayTo("h1.sock", TOKEN, { COTAL_LAUNCH_MATERIAL: m });
  check("H1: the hook exited cleanly", run.status === 0, run.stderr);
  check("H1: a managed launch relays one request proven with the key from the launch material", heard.requests.length === 1 && heard.requests[0]!.proven, heard.requests);
  check("H1: and the request carries the lifecycle event the hook was fired for", event(heard) === "SessionStart", heard.requests[0]);
  check("H1: and the key itself never crossed the socket", heard.raw.length > 0 && !heard.raw.includes(TOKEN), heard.raw);
}

// H2 - standalone: key and version exported directly, no material file. Still a supported path.
{
  const { heard, run } = await relayTo("h2.sock", "standalone-token-abc", { COTAL_CONTROL_KEY: "standalone-token-abc", COTAL_CONTROL_VERSION: "1" });
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
  const m = material("h4.json", { controlKey: TOKEN, controlVersion: 1 }, 0o644);
  const { heard, run } = await relayTo("h4.sock", TOKEN, { COTAL_LAUNCH_MATERIAL: m });
  check("H4: a world-readable material file yields no key, so nothing is relayed", heard.conns === 0, heard);
  check("H4: and that is reported, not silent", /readable beyond its owner/.test(run.stderr) && /presence relays are disabled/.test(run.stderr), run.stderr);
}

// H5 - a key without the version this plugin speaks is refused before any dial, and says so.
for (const [label, env] of [
  ["material with no controlVersion", { COTAL_LAUNCH_MATERIAL: material("h5a.json", { controlKey: TOKEN }) }],
  ["material with controlVersion 2", { COTAL_LAUNCH_MATERIAL: material("h5b.json", { controlKey: TOKEN, controlVersion: 2 }) }],
  ["a direct key with no COTAL_CONTROL_VERSION", { COTAL_CONTROL_KEY: TOKEN }],
  ["a direct key with COTAL_CONTROL_VERSION=2", { COTAL_CONTROL_KEY: TOKEN, COTAL_CONTROL_VERSION: "2" }],
] as const) {
  const { heard, run } = await relayTo(`h5-${label.length}.sock`, TOKEN, env);
  check(`H5: ${label} relays nothing`, heard.conns === 0, heard);
  check(`H5: ${label} is reported, not silent`, /control protocol version/.test(run.stderr), run.stderr);
}

// H6 - a stand-in on the socket: one without the key, and one of another version.
{
  const m = material("h6.json", { controlKey: TOKEN, controlVersion: 1 });
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
  const m = material("h7.json", { controlKey: TOKEN, controlVersion: 1 });
  const { heard, run } = await relayTo("open/h7.sock", TOKEN, { COTAL_LAUNCH_MATERIAL: m });
  check("H7: a socket in a directory other users can enter is not dialed", heard.conns === 0, heard);
  check("H7: and that is reported, not silent", /not private to this user/.test(run.stderr), run.stderr);
}

// H8 - a server that holds the key and sends a challenge the TypeScript client refuses.
{
  const m = material("h8.json", { controlKey: TOKEN, controlVersion: 1 });
  const nonce = (): string => randomBytes(32).toString("base64url");
  const cases: [string, (nc: string, ns: string) => string][] = [
    ["a challenge over the 1 KiB cap, in one write", (nc, ns) => JSON.stringify({ v: 1, nonce: ns, mac: mac(TOKEN, "server", nc, ns), pad: "p".repeat(4096) }) + "\n"],
    ["a nonce with a trailing newline", (nc) => {
      const odd = `${nonce()}\n`;
      return JSON.stringify({ v: 1, nonce: odd, mac: mac(TOKEN, "server", nc, odd) }) + "\n";
    }],
    ["a version of true", (nc, ns) => JSON.stringify({ v: true, nonce: ns, mac: mac(TOKEN, "server", nc, ns) }) + "\n"],
    ["a MAC with a character raised by 256", (nc, ns) => {
      const good = mac(TOKEN, "server", nc, ns);
      return JSON.stringify({ v: 1, nonce: ns, mac: String.fromCharCode(good.charCodeAt(0) + 256) + good.slice(1) }) + "\n";
    }],
  ];
  for (const [label, challenge] of cases) {
    const { heard } = await relayTo(`h8-${cases.findIndex((c) => c[0] === label)}.sock`, TOKEN, { COTAL_LAUNCH_MATERIAL: m }, 1, challenge);
    check(`H8: ${label}: the server gets the hello and no request`, heard.conns === 1 && heard.requests.length === 0, heard.requests);
  }
}

// H9 - the key's carriers, read as the TypeScript readers read them.
{
  const cases: [string, Record<string, string>, RegExp][] = [
    ["the old COTAL_CONTROL_TOKEN variable", { COTAL_CONTROL_TOKEN: TOKEN, COTAL_CONTROL_VERSION: "1" }, /COTAL_CONTROL_TOKEN is the control key variable/],
    ["the old controlToken material field", { COTAL_LAUNCH_MATERIAL: material("h9a.json", { controlToken: TOKEN, controlVersion: 1 }) }, /carries controlToken/],
    ["a controlVersion of true", { COTAL_LAUNCH_MATERIAL: material("h9b.json", { controlKey: TOKEN, controlVersion: true }) }, /controlVersion is not/],
    [
      "a direct key beside a material file",
      { COTAL_LAUNCH_MATERIAL: material("h9c.json", { controlKey: "material-key", controlVersion: 1 }), COTAL_CONTROL_KEY: TOKEN, COTAL_CONTROL_VERSION: "1" },
      /both in COTAL_LAUNCH_MATERIAL and as COTAL_CONTROL_KEY/,
    ],
    ["COTAL_CONTROL_VERSION with no key", { COTAL_CONTROL_VERSION: "1" }, /without COTAL_CONTROL_KEY/],
  ];
  for (const [i, [label, env, says]] of cases.entries()) {
    const { heard, run } = await relayTo(`h9-${i}.sock`, TOKEN, env);
    check(`H9: ${label} relays nothing and says why`, heard.conns === 0 && says.test(run.stderr), { conns: heard.conns, stderr: run.stderr });
  }
}

// H10 - the standalone bootstrap, driven through its real entry point up to the sidecar spawn.
{
  const bootstrap = (env: Record<string, string>) =>
    spawnSync(
      PY,
      [
        "-c",
        [
          "import json, os, cotal",
          "class Stop(Exception): pass",
          "def stop(): raise Stop()",
          "cotal._resolve_sidecar_js = stop",
          "try:",
          "    cotal._bootstrap_standalone_sidecar()",
          "except Stop:",
          "    print(json.dumps({'key': os.environ.get('COTAL_CONTROL_KEY'), 'version': os.environ.get('COTAL_CONTROL_VERSION')}))",
          "except RuntimeError as e:",
          "    print(json.dumps({'refused': str(e)}))",
        ].join("\n"),
      ],
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: work, PYTHONPATH: PLUGIN_DIR, ...env }, encoding: "utf8" },
    );
  const outcome = (env: Record<string, string>): { key?: string; version?: string; refused?: string } => {
    const r = bootstrap(env);
    try {
      return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    } catch {
      return { refused: `unparseable: ${r.stdout} ${r.stderr}` };
    }
  };
  const fresh = outcome({});
  check("H10: a standalone launch with no key gets a key and its version minted together", typeof fresh.key === "string" && fresh.key.length >= 43 && fresh.version === "1", fresh);
  const keyOnly = outcome({ COTAL_CONTROL_KEY: TOKEN });
  check("H10: a key with no version is refused, not given version 1", /COTAL_CONTROL_VERSION/.test(keyOnly.refused ?? ""), keyOnly);
  const versionOnly = outcome({ COTAL_CONTROL_VERSION: "1" });
  check("H10: a version with no key is refused, not given a minted key", /without COTAL_CONTROL_KEY/.test(versionOnly.refused ?? ""), versionOnly);
  const both = outcome({ COTAL_CONTROL_KEY: TOKEN, COTAL_CONTROL_VERSION: "1" });
  check("H10: a complete pair is used as it is", both.key === TOKEN && both.version === "1", both);
}

// H11 - what the Python client takes from a server that holds the key.
{
  /** Run one exchange from Python against `path`; report how it ended. */
  const exchangeFromPython = async (path: string): Promise<Record<string, string>> => {
    const child = spawn(
      PY,
      [
        "-c",
        [
          "import json, socket, sys",
          "from cotal.control_exchange import ClientExchange, ExchangeRefused",
          "s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])",
          "try:",
          "    ex = ClientExchange(s, sys.argv[2]); ex.open({'event': {}})",
          "    try: print(json.dumps({'reply': ex.reply(1.0)}))",
          "    except ExchangeRefused as e: print(json.dumps({'replyRefused': str(e)}))",
          "except ExchangeRefused as e: print(json.dumps({'openRefused': str(e)}))",
        ].join("\n"),
        path,
        TOKEN,
      ],
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONPATH: PLUGIN_DIR }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    await once(child, "exit");
    try {
      return JSON.parse(out.trim().split("\n").pop() ?? "") as Record<string, string>;
    } catch {
      return { unparseable: `${out} ${err}` };
    }
  };
  /** A server holding TOKEN: `challenge` gives the challenge bytes, `reply` runs on the request. */
  const keyServer = (name: string, challenge: (nc: string, ns: string) => Buffer, reply: (sock: Socket, nc: string, ns: string) => void) => {
    const path = join(work, name);
    const server = createServer((sock) => {
      sock.on("error", () => {});
      const ns = randomBytes(32).toString("base64url");
      sock.once("data", (hello) => {
        const nc = (JSON.parse(hello.toString().split("\n")[0]) as { nonce: string }).nonce;
        sock.write(challenge(nc, ns));
        sock.once("data", () => reply(sock, nc, ns));
      });
    });
    server.listen(path);
    return { path, server };
  };
  const proof = (nc: string, ns: string): Buffer => Buffer.from(JSON.stringify({ v: 1, nonce: ns, mac: mac(TOKEN, "server", nc, ns) }) + "\n");

  let written = 0;
  const flood = keyServer("h11-flood.sock", proof, (sock) => {
    const chunk = Buffer.alloc(1 << 16, 0x61);
    let open = true;
    sock.on("close", () => (open = false));
    sock.write(`${"A".repeat(43)} `);
    const pump = (): void => {
      while (open) {
        written += chunk.length;
        if (!sock.write(chunk)) return void sock.once("drain", pump);
      }
    };
    pump();
  });
  await once(flood.server, "listening");
  const flooded = await exchangeFromPython(flood.path);
  check("H11: a proven reply that never ends is refused near the 4 KiB cap", /oversized/.test(flooded.replyRefused ?? "") && written < 1 << 20, { ...flooded, written });
  flood.server.close();

  const utf16 = keyServer(
    "h11-utf16.sock",
    (nc, ns) => Buffer.concat([Buffer.from(JSON.stringify({ v: 1, nonce: ns, mac: mac(TOKEN, "server", nc, ns) }), "utf16le"), Buffer.from("\n")]),
    (sock, nc, ns) => sock.end(`${mac(TOKEN, "reply", nc, ns, "{}")} {}\n`),
  );
  await once(utf16.server, "listening");
  const sixteen = await exchangeFromPython(utf16.path);
  check("H11: a challenge encoded as UTF-16 is refused before any request", /not UTF-8 JSON/.test(sixteen.openRefused ?? ""), sixteen);
  utf16.server.close();

  const latin = keyServer("h11-latin1.sock", proof, (sock, nc, ns) => {
    const body = Buffer.from('{"a":"\xff"}', "latin1");
    const replyMac = createHmac("sha256", Buffer.from(TOKEN, "utf8"))
      .update(Buffer.concat([Buffer.from(`cotal-control/1\0reply\0${nc}\0${ns}\0`, "utf8"), body]))
      .digest("base64url");
    sock.end(Buffer.concat([Buffer.from(`${replyMac} `), body, Buffer.from("\n")]));
  });
  await once(latin.server, "listening");
  const notUtf8 = await exchangeFromPython(latin.path);
  check("H11: a proven reply that is not UTF-8 is refused, not returned", /not UTF-8/.test(notUtf8.replyRefused ?? ""), notUtf8);
  latin.server.close();
}

// H12 - one rule for the key's carriers, in both languages, over the same vectors. Each vector is a
// set of variables and, optionally, the text of a launch-material file; it expects the key, no key,
// or a refusal. "No key" is TypeScript's refusal of a socket with no key beside it, and Python's None.
{
  const K = "k".repeat(43);
  const direct = (key: string, version = "1"): Record<string, string> => ({ COTAL_CONTROL_KEY: key, COTAL_CONTROL_VERSION: version });
  const good = JSON.stringify({ controlKey: K, controlVersion: 1 });
  const vectors: { name: string; env?: Record<string, string>; material?: string; expect: string }[] = [
    { name: "a direct key and version 1", env: direct(K), expect: K },
    { name: "a direct key with a leading space", env: direct(` ${K}`), expect: "refused" },
    { name: "a direct key with a trailing space", env: direct(`${K} `), expect: "refused" },
    { name: "a direct key with a leading tab", env: direct(`\t${K}`), expect: "refused" },
    { name: "a direct key with a leading no-break space", env: direct(`\u00a0${K}`), expect: "refused" },
    { name: "a direct key with a leading byte order mark", env: direct(`\ufeff${K}`), expect: "refused" },
    { name: "a direct key starting with U+001F (Python whitespace, not JavaScript's)", env: direct(`\u001f${K}`), expect: `\u001f${K}` },
    { name: "a direct key starting with U+0085 (Python whitespace, not JavaScript's)", env: direct(`\u0085${K}`), expect: `\u0085${K}` },
    { name: "a whitespace-only key beside a version", env: direct("   "), expect: "refused" },
    { name: "version 01", env: direct(K, "01"), expect: "refused" },
    { name: "version ' 1'", env: direct(K, " 1"), expect: "refused" },
    { name: "version '1 '", env: direct(K, "1 "), expect: "refused" },
    { name: "version 2", env: direct(K, "2"), expect: "refused" },
    { name: "version +1", env: direct(K, "+1"), expect: "refused" },
    { name: "version 1.0", env: direct(K, "1.0"), expect: "refused" },
    { name: "version in fullwidth digits", env: direct(K, "\uff11"), expect: "refused" },
    { name: "a key with an empty version", env: { COTAL_CONTROL_KEY: K, COTAL_CONTROL_VERSION: "" }, expect: "refused" },
    { name: "a key with no version", env: { COTAL_CONTROL_KEY: K }, expect: "refused" },
    { name: "a version with no key", env: { COTAL_CONTROL_VERSION: "1" }, expect: "refused" },
    { name: "neither key nor version", env: {}, expect: "none" },
    { name: "the old COTAL_CONTROL_TOKEN", env: { COTAL_CONTROL_TOKEN: K }, expect: "refused" },
    { name: "a whitespace-only COTAL_CONTROL_TOKEN", env: { COTAL_CONTROL_TOKEN: "  " }, expect: "none" },
    { name: "a whitespace-only COTAL_LAUNCH_MATERIAL beside a direct pair", env: { ...direct(K), COTAL_LAUNCH_MATERIAL: "  " }, expect: K },
    { name: "material with a key and version 1", material: good, expect: K },
    ...[
      "COTAL_CREDS",
      "COTAL_SERVERS",
      "COTAL_TOKEN",
      "COTAL_OWNER",
      "COTAL_ACTOR",
      "COTAL_SENTINEL_CREDS",
      "COTAL_BEARER_CMD",
      "COTAL_EVENTS_REQUIRED",
      "COTAL_CONTROL_KEY",
      "COTAL_CONTROL_VERSION",
      "COTAL_CONTROL_TOKEN",
      "COTAL_LINK",
    ].map((name) => ({ name: `material beside a direct ${name}`, env: { [name]: "x" }, material: good, expect: "refused" })),
    { name: "material beside a whitespace-only COTAL_SERVERS", env: { COTAL_SERVERS: "  " }, material: good, expect: K },
    { name: "material with a key that has a leading space", material: JSON.stringify({ controlKey: ` ${K}`, controlVersion: 1 }), expect: "refused" },
    { name: "material with an empty key", material: JSON.stringify({ controlKey: "", controlVersion: 1 }), expect: "refused" },
    { name: "material with a whitespace-only key", material: JSON.stringify({ controlKey: "  ", controlVersion: 1 }), expect: "refused" },
    { name: "material with null key and version", material: JSON.stringify({ controlKey: null, controlVersion: null }), expect: "refused" },
    { name: "material with a null version only", material: JSON.stringify({ controlVersion: null, servers: "nats://x" }), expect: "refused" },
    { name: "material with a version and no key", material: JSON.stringify({ controlVersion: 1 }), expect: "refused" },
    { name: "material with a key and no version", material: JSON.stringify({ controlKey: K }), expect: "refused" },
    { name: "material with version 1.0", material: `{"controlKey":"${K}","controlVersion":1.0}`, expect: K },
    { name: "material with version true", material: JSON.stringify({ controlKey: K, controlVersion: true }), expect: "refused" },
    { name: 'material with version "1"', material: JSON.stringify({ controlKey: K, controlVersion: "1" }), expect: "refused" },
    { name: "material with the old controlToken", material: JSON.stringify({ controlToken: K }), expect: "refused" },
    { name: "material with no control fields", material: JSON.stringify({ servers: "nats://x" }), expect: "none" },
  ];
  const cases = vectors.map((v, i) => {
    const env = { ...v.env };
    if (v.material !== undefined) {
      const path = join(work, `h12-${i}.json`);
      writeFileSync(path, v.material, { mode: 0o600 });
      env.COTAL_LAUNCH_MATERIAL = path;
    }
    return env;
  });
  const ts = cases.map((env) => {
    try {
      const ep = controlFromEnv({ COTAL_CONTROL_SOCKET: join(work, "h12.sock"), ...env });
      return ep ? ep.token : "none";
    } catch (e) {
      return /no control key could be resolved/.test((e as Error).message) ? "none" : "refused";
    }
  });
  const py = spawnSync(
    PY,
    [
      "-c",
      [
        "import json, os, sys",
        "from cotal.control_exchange import ControlConfigError, control_key",
        "out = []",
        "for env in json.load(sys.stdin):",
        "    for k in [k for k in os.environ if k.startswith('COTAL_')]: del os.environ[k]",
        "    os.environ.update(env)",
        "    try:",
        "        key = control_key()",
        "        out.append('none' if key is None else key)",
        "    except ControlConfigError:",
        "        out.append('refused')",
        "print(json.dumps(out))",
      ].join("\n"),
    ],
    { input: JSON.stringify(cases), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONPATH: PLUGIN_DIR }, encoding: "utf8" },
  );
  let pyOut: string[] = [];
  try {
    pyOut = JSON.parse(py.stdout.trim().split("\n").pop() ?? "[]") as string[];
  } catch {
    check("H12: the Python reader ran over every vector", false, py.stderr);
  }
  for (const [i, v] of vectors.entries())
    check(`H12: ${v.name}: both readers give ${v.expect === K ? "the key" : v.expect}`, ts[i] === v.expect && pyOut[i] === v.expect, { ts: ts[i], py: pyOut[i] });
}

if (failed) {
  console.log(`\nHERMES HOOKS-CONTROL SMOKE FAILED ❌  (${failed} failed)`);
  process.exit(1);
}
console.log("\nHERMES HOOKS-CONTROL SMOKE OK ✅");
