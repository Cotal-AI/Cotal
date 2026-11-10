/** Real stack lifecycles keep recovery process pins attached to their exact instances. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, skipSuite } from "@cotal-ai/smoke-kit";
import { assertRecordIdentity } from "@cotal-ai/workspace";

if (process.platform !== "linux") skipSuite("stack-lost-records-transitions: Linux creation-pinned recovery");
const base = process.env.COTAL_LOST_HOME_TRANSITIONS_ROOT ?? mkdtempSync(join(tmpdir(), "cotal-home-transitions-"));
mkdirSync(base, { recursive: true, mode: 0o700 });
const binary = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
interface Pin { pid: number; token: string }
interface Journal { members: { role: string; instanceId: string | null; process?: Pin }[] }
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`); }
}
for (const scenario of ["forget", "managerless", "settled", "repeat"]) {
  const fixture = join(base, scenario), home = join(fixture, "home"), root = join(fixture, "project");
  for (const path of [fixture, home, root]) mkdirSync(path, { mode: 0o700 });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key))), HOME: fixture, XDG_CONFIG_HOME: join(fixture, "xdg"), COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
  let anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
  const file = join(root, ".cotal", "stack-controller.json");
  const journal = (): Journal => JSON.parse(readFileSync(file, "utf8")) as Journal;
  const pins = new Map<string, Pin>();
  const remember = () => {
    if (existsSync(file)) for (const row of journal().members) if (row.process) pins.set(`${row.process.pid}:${row.process.token}`, row.process);
  };
  const gone = (pin: Pin) => ["gone", "mismatch"].includes(assertRecordIdentity(pin).kind);
  const cli = (args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 150_000 };
    assertSmokeSandboxDown(anchor, args, options);
    const result = spawnSync(process.execPath, [binary, ...args, "--json"], options);
    if (result.error) throw new Error("owned CLI invocation did not complete");
    const data = JSON.parse(result.stdout) as { outcome?: string; error?: { code?: string; message?: string } };
    remember();
    return { exit: result.status, data };
  };
  const must = (args: string[]) => {
    const result = cli(args);
    if (result.exit !== 0) throw new Error(`fixture preparation failed: ${JSON.stringify(result)}`);
  };
  let hidden = false;
  const hide = () => {
    renameSync(home, `${home}-retained`); hidden = true;
    mkdirSync(home, { mode: 0o700 });
    anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
  };
  try {
    must(["space", "create", scenario]);
    must(["up", "--server", `nats://127.0.0.1:${await freePort()}`]);
    check(`${scenario}: real up records three live member identities`, pins.size === 3 && [...pins.values()].every((pin) => assertRecordIdentity(pin).kind === "match"));
    if (scenario === "repeat") {
      hide();
      const recovered = cli(["down", "--yes"]);
      check("recovery stops every exact original member", recovered.exit === 0 && [...pins.values()].every(gone), recovered);
    } else {
      must(["down", "--yes"]);
      check(`${scenario}: ordinary down stops every exact member`, [...pins.values()].every(gone));
    }
    if (scenario === "forget") {
      const forgotten = cli(["space", "forget", scenario]);
      check("ordinary up/down/forget succeeds without a partial retirement", forgotten.exit === 0, forgotten);
      check("retired members carry neither instance IDs nor process pins", journal().members.every((row) => row.instanceId === null && row.process === undefined));
    } else if (scenario === "managerless") {
      const manager = journal().members.find((row) => row.role === "manager")!;
      must(["up", "--no-manager"]);
      const current = journal().members.find((row) => row.role === "manager")!;
      check("managerless restart retains the stopped manager's matching creation pin", current.instanceId === manager.instanceId && JSON.stringify(current.process) === JSON.stringify(manager.process));
      const live = [...pins.values()].filter((pin) => assertRecordIdentity(pin).kind === "match");
      check("managerless restart has only broker and delivery running", live.length === 2);
      hide();
      const stopped = cli(["down", "--yes"]);
      check("lost-home stop succeeds after a full then managerless lifecycle", stopped.exit === 0 && live.every(gone), stopped);
    } else {
      if (scenario === "settled") hide();
      const before = readFileSync(file, "utf8");
      const stopped = cli(["down"]);
      check(`${scenario}: an already stopped stack needs no fresh confirmation`, stopped.exit === 0, stopped);
      check(`${scenario}: bare repeated stop leaves the settled journal unchanged`, readFileSync(file, "utf8") === before);
      const repeated = cli(["down", "--yes"]);
      check(`${scenario}: confirmed repeat is also a no-write no-op`, repeated.exit === 0 && readFileSync(file, "utf8") === before, repeated);
    }
  } finally {
    if (hidden) {
      if (existsSync(home)) renameSync(home, `${home}-recreated`);
      renameSync(`${home}-retained`, home);
      anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
    }
    if ([...pins.values()].some((pin) => !gone(pin))) {
      const cleanup = cli(["down", "--yes"]);
      if (cleanup.exit !== 0) throw new Error(`owned cleanup refused: ${JSON.stringify(cleanup)}`);
    }
    if (![...pins.values()].every(gone)) throw new Error("an owned creation-pinned member remains running");
  }
}
console.log(`STACK LOST RECORD TRANSITIONS ${failed ? "FAILED" : "OK"} (${passed} passed, ${failed} failed)`);
if (failed) process.exitCode = 1;
