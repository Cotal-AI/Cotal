/**
 * LIVE: `cotal up --max-payload <bytes>` must SERVE the limit and KEEP it across a plain later `up`.
 *
 * `serverConfig` has taken a `maxPayload` for as long as service endpoint caller grants have needed
 * one (they refuse below 2098176), but no flag passed it and `broker-policy.json` did not record it,
 * so `up` could not render it at all and a value written into `server.conf` by hand was lost the
 * next time `up` wrote the file. A hosted renderer outside `up` reads the recorded value, so the
 * record is what makes the two renders agree.
 *
 * Driven through the REAL binary as a subprocess, against a REAL broker, and judged on what the
 * broker SERVES, not on what the file says: `max_payload` is read off the `INFO` line the listener
 * sends on a raw socket. A text assertion alone would pass against a config that nats-server
 * ignored, and the failure this closes is precisely "the flag was accepted and nothing rendered it".
 *
 *  1. `up --max-payload N` renders `max_payload: N`, records it, and the listener advertises N.
 *  2. a running broker refuses a different `--max-payload`: the value is fixed at its start.
 *  3. `down`, then a PLAIN `up` with no flag renders and serves N again from the record.
 *  4. Open legacy and controller starts serve and retain the limit without adding authentication,
 *     and accept a replacement limit once stopped.
 *  5. An open broker-only start accepts a low limit, but adding a manager refuses before launch.
 *  6. A broker-only reuse on that low limit exits 0 but drops the add-manager hint from its Next
 *     section, naming the stop and restart instead; on a sufficient limit the hint stays. This is
 *     the controller route; the legacy open route's reuse receipt offers only `down`.
 *  7. Status after a busy-port first start tells the operator to keep the original startup options.
 *
 * Sandboxes COTAL_HOME and a project root under a scratch base with proven-clean `.cotal` ancestry;
 * kills only its own children. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-max-payload:live  (BUILD FIRST - the subprocess runs built dist.)
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";

const scratch = makeScratch("cotal-up-maxpayload-");
const home = mkdtempSync(join(scratch, "home-"));
let root = mkdtempSync(join(scratch, "root-"));
const configDir = join(home, "xdg");
let sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
process.env.COTAL_HOME = home;

const { authDir } = await import("@cotal-ai/workspace");
const { SERVICE_CALLER_PAYLOAD_FLOOR } = await import("@cotal-ai/core");

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
// Loading tsx into node makes the child the CLI itself; the `.bin/tsx` shim would relay only SIGINT
// and SIGTERM and orphan it.
const TSX_IMPORT = import.meta.resolve("tsx");

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** The ambient environment with every `COTAL_` key stripped, then this smoke's own sandbox put
 *  back: a suite run from a mesh-joined session would otherwise point the real CLI at the caller's
 *  mesh and pass while doing it. Enforced by bin/smoke/suite-ambient-env.smoke.ts. */
const sandboxEnv = (() => {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) if (key.startsWith("COTAL_")) delete copy[key];
  return { ...copy, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
})();

const kids: ChildProcess[] = [];
async function run(args: string[], timeoutMs?: number, stdin?: Buffer): Promise<{ status: number | null; out: string }> {
  const options = { cwd: root, env: sandboxEnv, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] as ["ignore" | "pipe", "pipe", "pipe"] };
  assertSmokeSandboxDown(sandbox, args, options);
  const cp = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  kids.push(cp);
  let out = "";
  cp.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  cp.stderr?.on("data", (b: Buffer) => { out += b.toString(); });
  if (stdin !== undefined) {
    cp.stdin!.on("error", () => {});
    cp.stdin!.write(stdin); // Keep the pipe open until the command exits.
  }
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => cp.kill("SIGTERM"), timeoutMs);
  try { await once(cp, "close"); } finally { clearTimeout(timeout); }
  return { status: cp.exitCode, out };
}

/** The `max_payload` the LISTENER advertises on its `INFO` greeting, or undefined when no greeting
 *  arrived. A raw socket needs no credential to read it. */
function servedMaxPayload(port: number, timeoutMs = 5_000): Promise<number | undefined> {
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    const done = (v: number | undefined) => { try { sock.destroy(); } catch { /* already gone */ } res(v); };
    sock.setTimeout(timeoutMs, () => done(undefined));
    sock.on("error", () => done(undefined));
    sock.on("close", () => done(undefined));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      try { done((JSON.parse(buf.slice(0, nl).replace(/^INFO\s+/, "")) as { max_payload?: number }).max_payload); }
      catch { done(undefined); }
    });
  });
}

let open = false;
const confText = () => readFileSync(open ? join(root, ".cotal", "server-open.conf") : join(authDir(root), "server.conf"), "utf8");
const recordedPayload = () => (JSON.parse(readFileSync(join(root, ".cotal", "broker-policy.json"), "utf8")) as { maxPayload?: number }).maxPayload;

async function checkFifoBody(space: string, server: string): Promise<void> {
  const target = ["--space", space, "--server", server, "--json"];
  const small = join(root, "small.txt");
  writeFileSync(small, "short file body");
  const sent = await run(["send", "-c", "fifo-body", "--file", small, ...target]);
  ok("a short file body is stored on the low-limit broker", sent.status === 0 && JSON.parse(sent.out).result?.stored === true, sent.out);

  const fifo = join(root, "body.fifo");
  execFileSync("mkfifo", [fifo]);
  // The producer holds the FIFO open until the parent stops it, even after writing the entire body.
  const writer = spawn(process.execPath, ["-e", `
    const { openSync, writeFileSync } = require("node:fs");
    writeFileSync(openSync(process.argv[1], "w"), Buffer.alloc(8193, "a"));
    process.stdin.resume();
  `, fifo], { stdio: ["pipe", "ignore", "ignore"] });
  kids.push(writer);
  const closed = once(writer, "close");
  try {
    const refused = await run(["send", "-c", "fifo-body", "--file", fifo, ...target], 10_000);
    ok("a FIFO one byte over the broker limit refuses while its writer is still open", refused.status === 2 && writer.exitCode === null && writer.signalCode === null &&
      JSON.parse(refused.out).error?.code === "UNSUPPORTED" && refused.out.includes("8192-byte message limit; nothing was sent"), refused.out);
  } finally {
    writer.stdin.end();
    writer.kill();
    await closed;
  }
  const history = await run(["history", "fifo-body", ...target]);
  const items = JSON.parse(history.out).result?.items as { text: string }[] | undefined;
  ok("only the short file reaches history", history.status === 0 && items?.length === 1 && items[0]?.text === "short file body", history.out);
}

async function checkMode(mode: "auth" | "open-legacy" | "open-controller"): Promise<void> {
  open = mode !== "auth";
  root = mkdtempSync(join(scratch, `${mode}-`));
  sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
  console.log(`\n${mode}:`);
  if (mode !== "open-controller") mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "up max-payload fixture");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = `payload-${mode}`;
  if (mode === "open-controller") {
    const prepared = await run(["space", "create", space, "--root", root]);
    ok("controller fixture is prepared", prepared.status === 0, prepared.out.slice(-1500));
  }
  let asked = open ? 2097152 : SERVICE_CALLER_PAYLOAD_FLOOR;
  const flags = mode === "open-controller" ? ["--open"] : ["--no-manager", ...(open ? ["--open"] : [])];

  if (open) {
    const args = ["--no-manager", "--space", space, "--server", server];
    let stopped = false;
    try {
      const started = await run(["up", "--open", ...args]);
      ok("open broker starts with no payload override", started.status === 0 && await servedMaxPayload(port) === 1048576, started.out);
      const reuse = await run(["up", ...args, "--max-payload", "1048576"]);
      ok("explicit default payload reuses the running broker", reuse.status === 0 && /already running/.test(reuse.out), reuse.out);
      ok("reusing the default does not record an override", !existsSync(join(root, ".cotal", "broker-policy.json")));
      const change = await run(["up", ...args, "--max-payload", String(asked)]);
      ok("a real change is refused and its retry keeps the broker manager-free",
        change.status !== 0 && change.out.includes(`cotal up --no-manager --max-payload ${asked}`) && await servedMaxPayload(port) === 1048576, change.out);
      const down = await run(["down", "--yes"]);
      stopped = down.status === 0;
      ok("the default broker stops", down.status === 0, down.out);
      if (mode === "open-controller") {
        stopped = false;
        const widen = await run(["up", ...args, "--host", "0.0.0.0"]);
        ok("a stopped stack refuses a wider bind", widen.status === 2 && widen.out.includes("--host 0.0.0.0 (recorded: 127.0.0.1)") && await servedMaxPayload(port) === undefined, widen.out);
        const restart = await run(["up", ...args, "--host", "127.0.0.1"]);
        ok("a stopped stack restarts on its explicit loopback bind", restart.status === 0 && restart.out.includes("Controller stack started") && await servedMaxPayload(port) === 1048576, restart.out);
      }
    } finally {
      if (!stopped) {
        const clean = await run(["down", "--yes"]);
        ok("the default broker is down before testing an override", clean.status === 0, clean.out);
      }
    }
  }

  console.log(`1) cotal up --max-payload ${asked}`);
  const first = await run(["up", "--detach", ...flags, "--space", space, "--server", server, "--max-payload", String(asked), ...(mode === "open-controller" ? ["--json"] : [])]);
  ok("up --max-payload exits 0", first.status === 0, first.out.slice(-1500));
  ok("…and renders max_payload into the broker config", confText().includes(`\nmax_payload: ${asked}\n`), confText().split("\n").filter((l) => l.startsWith("max_payload")));
  if (open) ok("open config carries no authentication material", !/^(operator|system_account|resolver):/m.test(confText()), confText());
  ok("…and records it in the broker policy", recordedPayload() === asked, recordedPayload());
  ok("…and the listener ADVERTISES it, so the broker is serving the limit", await servedMaxPayload(port) === asked, await servedMaxPayload(port));

  console.log("\n2) a running broker refuses a different --max-payload");
  const conflict = await run(["up", ...flags, "--space", space, "--server", server, "--max-payload", String(asked + 4096)]);
  ok("a different --max-payload on a running broker exits non-zero", conflict.status !== 0, { status: conflict.status, out: conflict.out.slice(-800) });
  ok("…naming that the limit is fixed at start and the `cotal down` that frees it",
    (conflict.out.includes("can't change --max-payload") || conflict.out.includes("fixed at its start")) && conflict.out.includes("cotal down"), conflict.out.slice(-800));
  ok("…and changes neither the record nor what is served", recordedPayload() === asked && await servedMaxPayload(port) === asked);

  console.log("\n3) down, then a PLAIN up renders the recorded limit again");
  const down = await run(["down", "--yes"]);
  ok("down exits 0", down.status === 0, down.out.slice(-1500));
  if (mode === "open-controller") {
    const watch = await run(["watch", "--space", space, "--plain"]);
    ok("watch still recommends bare up for a stopped manager-backed stack", watch.status === 2 && watch.out.includes(`start it again with \`cotal up\` in ${root}`), watch.out);
  }
  const again = await run(["up", "--detach", ...flags, "--space", space, "--server", server]);
  ok("a plain up with no flag exits 0", again.status === 0, again.out.slice(-1500));
  ok("…and renders the recorded max_payload again", confText().includes(`\nmax_payload: ${asked}\n`), confText().split("\n").filter((l) => l.startsWith("max_payload")));
  ok("…and the restarted listener still advertises it", await servedMaxPayload(port) === asked, await servedMaxPayload(port));
  ok("…and the record is unchanged", recordedPayload() === asked, recordedPayload());

  if (open) {
    const stopped = await run(["down", "--yes"]);
    ok("open stack stops before replacing its payload limit", stopped.status === 0, stopped.out.slice(-1500));
    asked += 4096;
    // No --open: the controller must also accept the limit when its recorded mode selects open.
    const replace = await run(["up", "--detach", "--no-manager", ...(mode === "open-legacy" ? ["--open"] : []), "--space", space, "--server", server, "--max-payload", String(asked)]);
    ok("stopped open stack accepts a replacement limit", replace.status === 0, replace.out.slice(-1500));
    ok("replacement is rendered, recorded and served", confText().includes(`\nmax_payload: ${asked}\n`) && recordedPayload() === asked && await servedMaxPayload(port) === asked);
  }
  const last = await run(["down", "--yes"]);
  ok("the final down exits 0", last.status === 0, last.out.slice(-1500));

  if (mode === "auth") {
    const brokerOnly = await run(["up", "--no-manager", "--space", space, "--server", server, "--max-payload", "131072"]);
    try {
      ok("the static-auth broker serves the low limit", brokerOnly.status === 0 && await servedMaxPayload(port) === 131072, brokerOnly.out);
      for (const args of [["ps"], ["spawn", "-d"]]) {
        const result = await run([...args, "--space", space, "--plain"]);
        ok(`${args[0]} refuses and explains how to restart with enough payload`, result.status === 2 &&
          result.out.includes("payload limit is 131072 bytes, below the manager's minimum of 263168 bytes") &&
          result.out.includes("fixed while the broker runs") && result.out.includes("cotal down --yes") &&
          result.out.includes("cotal up --foreground --max-payload 1048576"), result.out);
      }
      ok("the agent commands leave the low-payload broker running", await servedMaxPayload(port) === 131072);
    } finally {
      const clean = await run(["down", "--yes"]);
      ok("the low-payload static-auth broker stops", clean.status === 0, clean.out);
    }
  }

  if (open) {
    const brokerOnly = await run(["up", "--open", "--no-manager", "--space", space, "--server", server, "--max-payload", "8192"]);
    try {
      ok("a broker-only start accepts and serves 8192 bytes", brokerOnly.status === 0 && await servedMaxPayload(port) === 8192, brokerOnly.out);
      const source = mode === "open-controller" ? ["--file", "-"] : ["--stdin"];
      const oversized = await run(["send", "-c", "general", ...source, "--json", "--space", space, "--server", server], 10_000, Buffer.alloc(8193, "a"));
      ok(`${source.join(" ")} refuses one byte over the broker limit before EOF`, oversized.status === 2 &&
        oversized.out.includes('"code":"UNSUPPORTED"') && oversized.out.includes("8192-byte message limit; nothing was sent"), oversized.out);
      // Only the controller route renders the add-manager hint: the legacy open route's reuse
      // receipt offers only `down`, so there is no hint to drop there.
      if (mode === "open-controller") {
        if (process.platform !== "win32") await checkFifoBody(space, server);
        const ps = await run(["ps", "--space", space, "--plain"]);
        ok("ps on an open controller low-payload broker explains why bare up cannot add a manager",
          ps.status === 2 &&
          ps.out.includes("payload limit is 8192 bytes, below the manager's minimum of 263168 bytes") &&
          ps.out.includes("fixed while the broker runs") &&
          ["cotal", "pnpm cotal"].some((cli) => ps.out.includes(`\`${cli} down --yes\``)) &&
          ["cotal", "pnpm cotal"].some((cli) => ps.out.includes(`\`${cli} up --foreground --max-payload 1048576\``)),
          ps.out);
        const reuse = await run(["up", "--no-manager", "--space", space, "--server", server]);
        ok("a broker-only reuse exits 0 and its Next drops the add-manager hint for the low limit",
          reuse.status === 0 && /already running/.test(reuse.out) && !reuse.out.includes("Add the manager to this stack") &&
          reuse.out.includes("cotal up --max-payload 1048576") && reuse.out.includes("stop the broker first") &&
          reuse.out.includes("cotal down"), reuse.out);
      }
      const add = await run(["up", "--server", server]);
      ok("adding a manager refuses on the recorded floor before launch",
        add.status === 1 && add.out.includes("--max-payload 8192 is below 263168 bytes") &&
        add.out.includes("nothing was started") && !add.out.includes("Starting stack-manager"), add.out);
      ok("the refusal gives a stop and restart command and a broker-only option",
        add.out.includes("cotal down --yes") && add.out.includes("cotal up --max-payload 1048576") &&
        add.out.includes("cotal up --no-manager"), add.out);
      const status = await run(["status", "--components", "--space", space]);
      ok("the manager stays intentionally omitted and the broker keeps its limit",
        /manager\s+not-started.*started with --no-manager/.test(status.out) &&
        /broker\s+serving/.test(status.out) && recordedPayload() === 8192 && await servedMaxPayload(port) === 8192, status.out);
    } finally {
      const clean = await run(["down", "--yes"]);
      ok("the low-payload broker stops", clean.status === 0, clean.out);
    }
    if (mode === "open-controller") await checkStoppedBrokerOnly(space, port);
    else await checkStoppedOpenForeground(server, port);
    const wide = await run(["up", "--open", "--no-manager", "--space", space, "--server", server, "--max-payload", "1048576"]);
    try {
      ok("a broker-only start accepts and serves 1048576 bytes", wide.status === 0 && await servedMaxPayload(port) === 1048576, wide.out);
      if (mode === "open-controller") {
        const wideReuse = await run(["up", "--no-manager", "--space", space, "--server", server]);
        ok("a broker-only reuse on a sufficient limit still offers adding the manager",
          wideReuse.status === 0 && /already running/.test(wideReuse.out) && wideReuse.out.includes("Add the manager to this stack"), wideReuse.out);
      }
    } finally {
      const clean = await run(["down", "--yes"]);
      ok("the sufficient-payload broker stops", clean.status === 0, clean.out);
    }
  }
}

async function checkStoppedOpenForeground(server: string, port: number): Promise<void> {
  const before = confText();
  const restart = await run(["up", "--foreground", "--server", server], 15_000);
  try {
    ok("a cold legacy open foreground start with the recorded low limit refuses before launch",
      restart.status === 1 && restart.out.includes("--max-payload 8192 is below 263168 bytes") &&
      restart.out.includes("pass --no-manager") && !restart.out.includes("Starting nats-server"), restart.out);
    ok("the refused start leaves the open config and policy unchanged and no listener", confText() === before &&
      recordedPayload() === 8192 && await servedMaxPayload(port) === undefined, restart.out);
  } finally {
    if (await servedMaxPayload(port) !== undefined) await run(["down", "--yes"]);
  }
}

async function checkStoppedBrokerOnly(space: string, port: number): Promise<void> {
  const next = `start it again with \`cotal up --no-manager\` in ${root}`;
  const plain = await run(["watch", "--space", space, "--plain"]);
  ok("watch refuses a stopped broker-only space and names the broker-only restart", plain.status === 2 && plain.out.includes("TARGET_UNAVAILABLE") && plain.out.includes(next), plain.out);
  const json = await run(["watch", "--space", space, "--json"]);
  const [error, end] = json.out.trim().split("\n").map((line) => JSON.parse(line));
  ok("watch JSON reports the same refusal and restart remedy", json.status === 2 && error?.type === "error" && error.data.code === "TARGET_UNAVAILABLE" && error.data.remedy === next && end?.type === "end", json.out);
  const status = await run(["status", "--components", "--space", space]);
  const health = status.out.split("Component Health")[1] ?? "";
  ok("component health keeps the broker-only restart advice", status.status === 1 && /start it again with `(?:pnpm )?cotal up --no-manager` in /.test(health), status.out);
  for (const args of [["space", "show", space], ["use", space]]) {
    const result = await run(args);
    const advice = result.out.replace("`pnpm cotal up", "`cotal up");
    ok(`${args.join(" ")} names the broker-only restart in the saved project`, result.status === 0 && advice.includes(next), result.out);
  }

  const restart = await run(["up", "--no-manager"]);
  try {
    ok("the advised command starts the stopped broker on its recorded low limit", restart.status === 0 && await servedMaxPayload(port) === 8192, restart.out);
    const who = await run(["who", "--json"]);
    ok("who connects to the restarted broker with no manager", who.status === 0 && who.out.includes('"managers":"none-present"'), who.out);
  } finally {
    const clean = await run(["down", "--yes"]);
    ok("the restarted broker stops", clean.status === 0, clean.out);
  }
}

async function checkBlockedFirstStart(): Promise<void> {
  const space = "payload-blocked-first";
  root = mkdtempSync(join(scratch, `${space}-`));
  sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
  const prepared = await run(["space", "create", space]);
  ok("the busy-port fixture is prepared", prepared.status === 0, prepared.out);
  const holder = net.createServer((socket) => socket.end("not NATS\n"));
  holder.listen(0, "127.0.0.1");
  await once(holder, "listening");
  const port = (holder.address() as net.AddressInfo).port;
  const options = ["--open", "--no-manager", "--max-payload", "8192"];
  try {
    const refused = await run(["up", ...options, "--server", `nats://127.0.0.1:${port}`]);
    ok("the busy port refuses the first start", refused.status === 2 && refused.out.includes("CONFLICT"), refused.out);
    const status = await run(["status", "--plain", "--space", space]);
    const alternate = /`--server (nats:\/\/127\.0\.0\.1:(\d+))` and all other options unchanged/.exec(status.out);
    ok("status says to repeat the original command or change only its server",
      status.status === 0 && status.out.includes(`stop the process listening on 127.0.0.1:${port}, then repeat your original startup command from the same folder`) &&
      alternate !== null && Number(alternate[2]) !== port && !/`(?:pnpm )?cotal up\b/.test(status.out), status.out);
    try {
      const started = await run(["up", ...options, "--server", alternate![1]!]);
      const health = await run(["status", "--components", "--space", space]);
      ok("changing only the server starts a broker with the original payload limit and no manager",
        started.status === 0 && await servedMaxPayload(Number(alternate![2])) === 8192 &&
        /manager\s+not-started.*started with --no-manager/.test(health.out), `${started.out}\n${health.out}`);
    } finally {
      const stopped = await run(["down", "--yes"]);
      ok("the recovered broker stops", stopped.status === 0, stopped.out);
    }
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
}

try {
  for (const mode of ["auth", "open-legacy", "open-controller"] as const) await checkMode(mode);
  await checkBlockedFirstStart();
  console.log(`\nup-max-payload live smoke: OK - ${pass} checks`);
} finally {
  for (const cp of kids) { try { cp.kill("SIGKILL"); } catch { /* already gone */ } }
}
