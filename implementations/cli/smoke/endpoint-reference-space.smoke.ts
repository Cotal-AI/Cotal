import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, listenOn } from "@cotal-ai/smoke-kit";

const bin = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
const sandbox = mkdtempSync(join(tmpdir(), "cotal-endpoint-reference-space-"));
const project = join(sandbox, "project");
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  HOME: join(sandbox, "home"), USERPROFILE: join(sandbox, "home"), LOCALAPPDATA: join(sandbox, "local"),
  XDG_CONFIG_HOME: join(sandbox, "config"), XDG_DATA_HOME: join(sandbox, "data"),
  XDG_STATE_HOME: join(sandbox, "state"), XDG_CACHE_HOME: join(sandbox, "cache"), XDG_RUNTIME_DIR: join(sandbox, "runtime"),
  TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox, COTAL_HOME: join(sandbox, "registry"),
  DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1",
};
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));
mkdirSync(env.HOME, { mode: 0o700 });
mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
// Bound the project lookup even when the temporary directory is below a Cotal project.
mkdirSync(join(project, ".cotal"), { recursive: true, mode: 0o700 });

interface Envelope<R> {
  command: string;
  outcome: string;
  completeness: string;
  target: { requested?: string; space?: string } | null;
  result: R | null;
  error?: { code: string; message: string; remedy?: string };
}

async function run<R = unknown>(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const { status, stdout, stderr } = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], { cwd: project, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ status: Number(error?.code ?? 0), stdout, stderr });
    });
  });
  const envelope = stdout.startsWith("{") ? JSON.parse(stdout) as Envelope<R> : undefined;
  return { status, stdout, stderr, envelope };
}

const { check, finish } = createSuite();
const prepared = await run(["space", "create", "machine-audit"]);
check("the space is prepared and not started", prepared.status === 0 && prepared.stderr === "", prepared);

const retry = "`cotal endpoint --space <name> --json`";
const missing = await run(["endpoint", "--space", "missing-space", "--json"]);
const refusal = missing.envelope;
check("JSON names the requested space and shows how to retry without a resolved space",
  missing.status === 2 && missing.stderr === "" && refusal?.command === "endpoint" && refusal.outcome === "refused"
    && refusal.completeness === "not-checked" && refusal.result === null
    && refusal.target?.requested === "missing-space" && !Object.hasOwn(refusal.target, "space")
    && refusal.error?.code === "TARGET_NOT_FOUND" && refusal.error.message.includes('"missing-space"')
    && refusal.error.remedy?.includes("`cotal space`") === true && refusal.error.remedy.includes(retry), missing);

const plain = await run(["endpoint", "--space", "missing-space", "--plain"]);
check("plain output shows the same refusal and recovery without a Mesh heading",
  plain.status === 2 && plain.stdout === "" && /Code:\s+TARGET_NOT_FOUND/.test(plain.stderr)
    && plain.stderr.includes('"missing-space"') && plain.stderr.includes("`cotal space`")
    && plain.stderr.includes(retry) && !plain.stderr.includes("Mesh:"), plain);

const correct = await run<{ kind: string; liveCompleteness: string }>(["endpoint", "--space", "machine-audit", "--json"]);
check("the named prepared space still lists saved references without a live read",
  correct.status === 0 && correct.stderr === "" && correct.envelope?.outcome === "ok" && correct.envelope.completeness === "complete"
    && correct.envelope.target?.space === "machine-audit" && correct.envelope.result?.kind === "endpoint-references"
    && correct.envelope.result.liveCompleteness === "not-checked", correct);

const spaces = await run<{ current: string | null; items: unknown[]; prepared: { space: string; lastOperation: unknown }[] }>(["space", "--json"]);
check("space lists the prepared name without a registration, stack operation or selection",
  spaces.status === 0 && spaces.stderr === "" && spaces.envelope?.result?.current === null && spaces.envelope.result.items.length === 0
    && spaces.envelope.result.prepared.some(row => row.space === "machine-audit" && row.lastOperation === null), spaces);

const received: Record<string, unknown>[] = [];
const intake = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
  req.on("end", () => {
    if (req.method === "POST" && req.headers["content-type"] === "application/json") received.push(JSON.parse(body) as Record<string, unknown>);
    res.writeHead(204).end();
  });
});
await listenOn(intake, 0);
try {
  const address = intake.address();
  if (!address || typeof address === "string") throw new Error("telemetry intake did not bind to a loopback port");
  const telemetry = { DO_NOT_TRACK: undefined, COTAL_TELEMETRY: "regular", COTAL_TELEMETRY_URL: `http://127.0.0.1:${address.port}/v1/telemetry` };
  for (const [label, name] of [["ordinary", "unknown-plain-space"], ["embedded quote", 'quoted-space-prefix"quoted-space-suffix']] as const) {
    const before = received.length;
    const local = await run(["endpoint", "--space", name, "--json"], telemetry);
    check(`${label}: local JSON retains the exact name and retry`, local.status === 2 && local.stderr === ""
      && local.envelope?.target?.requested === name && local.envelope.error?.message.includes(name) === true
      && local.envelope.error.remedy?.includes(retry) === true, local);
    const bodies = received.slice(before);
    const events = bodies.filter(event => event.event === "command");
    const event = events[0];
    const payload = JSON.stringify(bodies);
    check(`${label}: regular telemetry keeps the code and omits the local diagnostic`, events.length === 1
      && event?.level === "regular" && event.command === "endpoint" && event.outcome === "refused"
      && event.exitCode === 2 && event.errorCode === "TARGET_NOT_FOUND" && event.errorMessage === null && event.errorStack === null
      && name.split('"').every(part => !payload.includes(part)), bodies);
  }
} finally {
  await new Promise<void>((resolve, reject) => intake.close(error => error ? reject(error) : resolve()));
}

finish();
process.exit(process.exitCode ?? 0);
