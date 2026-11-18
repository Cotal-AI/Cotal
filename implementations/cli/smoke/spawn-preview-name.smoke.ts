/** Direct launch previews must apply the same effective-name rule as foreground launches.
 * Run after building the binary: pnpm exec tsx implementations/cli/smoke/spawn-preview-name.smoke.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordMesh } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const bin = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
const root = mkdtempSync(join(tmpdir(), "cotal-spawn-preview-name-"));
// Retain the isolated inputs when collecting before/after evidence.
if (process.env.COTAL_SMOKE_RETAIN !== "1") process.on("exit", () => rmSync(root, { recursive: true, force: true }));
console.log(`Sandbox: ${root}`);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["FORCE_COLOR", "NO_COLOR"].includes(key)));
const server = "nats://127.0.0.1:34300";
function sandbox(label: string) {
  const dir = join(root, label);
  const project = join(dir, "project");
  const home = join(dir, "home");
  const cotalHome = join(dir, "cotal-home");
  const config = join(dir, "config");
  const runtime = join(dir, "runtime");
  const temp = join(dir, "tmp");
  for (const path of [home, cotalHome, config, runtime, temp, join(project, ".cotal", "agents")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const [file, name] of [["minimal", "minimal"], ["invalid-name", "bad name"]]) {
    writeFileSync(join(project, ".cotal", "agents", `${file}.md`), `---\nname: ${name}\n---\nReview the project.\n`);
  }
  return { project, cotalHome, env: { ...inherited, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: join(dir, "cache"), XDG_DATA_HOME: join(dir, "data"), TMPDIR: temp, COTAL_HOME: cotalHome, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" } };
}
type Sandbox = ReturnType<typeof sandbox>;
function cli(site: Sandbox, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: site.project, env: site.env, encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function preview(site: Sandbox, args: string[], name: string, refusal?: string) {
  for (const json of [false, true]) {
    const result = cli(site, ["spawn", ...args, "--dry-run", ...(json ? ["--json"] : [])]);
    const body = json ? JSON.parse(result.stdout) : undefined;
    check(`${args.join(" ")} ${json ? "JSON" : "text"}: ${refusal ? "refuses" : "accepts"} ${JSON.stringify(name)}`,
      refusal === undefined
        ? result.status === 0 && (json ? body.outcome === "ok" && body.completeness === "complete" && body.result.requestedName === name : result.stdout.includes(name))
        : result.status === 1 && (json ? body.outcome === "refused" && body.error?.code === "USAGE_INVALID" && body.error.message.includes(refusal) : result.stderr.includes(refusal)), result);
  }
}
const adhoc = sandbox("adhoc");
const prepared = sandbox("prepared");
const user = sandbox("user");
const created = cli(prepared, ["space", "create", "prep", "--root", ".", "--json"]);
check("control: prepares a local space through the CLI", created.status === 0 && JSON.parse(created.stdout).outcome === "ok", created);
const previousHome = process.env.COTAL_HOME;
try {
  process.env.COTAL_HOME = user.cotalHome;
  recordMesh({ space: "usermesh", server, root: user.project, mode: "user", origin: "manual", userAuth: { provider: "cotal", idp: { url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "https://idp.example" } }, ts: new Date().toISOString() });
} finally {
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
}

// Positive controls establish the preview path, name precedence and the mode-specific grammar.
preview(adhoc, ["minimal", "--server", server], "minimal");
preview(adhoc, ["minimal", "--name", "good-name", "--server", server], "good-name");
preview(adhoc, ["invalid-name", "--name", "good_name", "--server", server], "good_name");
preview(prepared, ["minimal"], "minimal");
preview(user, ["minimal", "--name", "good_user_name", "--space", "usermesh"], "good_user_name");
preview(user, ["minimal", "--name", "a".repeat(64), "--space", "usermesh"], "a".repeat(64));
const foreground = cli(adhoc, ["spawn", "minimal", "--foreground", "--server", server]);
check("control: valid foreground name reaches broker preflight", foreground.status === 1 && foreground.stderr.includes(`nothing answered at ${server}`), foreground);

const unsafe = 'unsafe name "bad name"';
preview(adhoc, ["invalid-name", "--server", server], "bad name", unsafe);
preview(adhoc, ["minimal", "--name", "bad name", "--server", server], "bad name", unsafe);
preview(prepared, ["invalid-name"], "bad name", unsafe);
preview(user, ["minimal", "--name", "bad-hyphen", "--space", "usermesh"], "bad-hyphen", 'name "bad-hyphen" cannot be a mesh identity in user mode');
preview(user, ["minimal", "--name", "a".repeat(65), "--space", "usermesh"], "a".repeat(65), "cannot be a mesh identity in user mode");
for (const [site, args, refusal] of [
  [adhoc, ["invalid-name", "--server", server], unsafe],
  [adhoc, ["minimal", "--name", "bad name", "--server", server], unsafe],
  [user, ["minimal", "--name", "bad-hyphen", "--space", "usermesh"], "cannot be a mesh identity in user mode"],
] as const) {
  const result = cli(site, ["spawn", ...args, "--foreground"]);
  check(`foreground refuses the same effective name: ${args.join(" ")}`, result.status === 1 && result.stderr.includes(refusal) && !result.stderr.includes("nothing answered"), result);
}
finish();
