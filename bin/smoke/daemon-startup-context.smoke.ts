/** Machine-daemon entry points must not depend on an unrelated project folder or preferences. */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths, daemonPathsFor } from "../daemon/endpoint.js";

if (process.platform !== "linux") skipSuite("daemon-startup-context: owned Linux foreground daemons; native service acceptance is separate");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bin = join(repo, "bin", "dist", "cotal.js");
const root = mkdtempSync(join(tmpdir(), "cotal-context-")); chmodSync(root, 0o700);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`); }
}
type Result = { code: number | null; signal: NodeJS.Signals | null; out: string; err: string; doc: Record<string, any> };
type Fault = "healthy" | "preferences" | "project-file" | "parent-file" | "removed-folder";
const marker = "PRIVATE_CONTEXT_MARKER";
const children = new Set<ChildProcess>();

try {
  for (const selected of [false, true]) {
    const name = selected ? "selected" : "default";
    const fixture = join(root, name);
    for (const dir of [fixture, ...["home", "runtime", "config", "data", "cache", "neutral", "notes", "notes/child", "daemon-home"].map((p) => join(fixture, p))]) mkdirSync(dir, { mode: 0o700 });
    mkdirSync(join(fixture, "config/cotal"), { mode: 0o700 });
    const preferences = join(fixture, "config/cotal/preferences.json");
    const valid = JSON.stringify({ schemaVersion: 1, revision: 1, defaults: {}, spaces: {} });
    writeFileSync(preferences, valid, { mode: 0o600 });
    writeFileSync(join(fixture, "notes/.cotal"), marker, { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH", "FORCE_COLOR"].includes(key)));
    Object.assign(env, { HOME: join(fixture, "home"), XDG_RUNTIME_DIR: join(fixture, "runtime"), XDG_CONFIG_HOME: join(fixture, "config"), XDG_DATA_HOME: join(fixture, "data"), XDG_CACHE_HOME: join(fixture, "cache"), COTAL_HOME: join(fixture, "home/.cotal"), DO_NOT_TRACK: "1", NO_COLOR: "1" });
    const homeFlags = selected ? ["--daemon-home", join(fixture, "daemon-home")] : [];
    const paths = selected ? daemonPathsFor(join(fixture, "daemon-home"), env) : daemonPaths(env, env.COTAL_HOME);
    function launch(args: string[], fault: Fault): ChildProcess {
      const cwd = join(fixture, fault === "project-file" ? "notes" : fault === "parent-file" ? "notes/child" : "neutral");
      let executable = process.execPath, words = [bin, ...args];
      if (fault === "removed-folder") {
        // This shell owns the empty disposable directory; no daemon state is stored in it.
        const gone = mkdtempSync(join(fixture, "gone-"));
        executable = "/bin/sh";
        words = ["-c", 'cd "$1" && rmdir "$1" && shift && exec "$@"', "sh", gone, process.execPath, bin, ...args];
      }
      const child = spawn(executable, words, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      children.add(child); child.once("close", () => children.delete(child));
      return child;
    }
    async function call(args: string[], fault: Fault, input = ""): Promise<Result> {
      const child = launch(args, fault);
      let out = "", err = "";
      child.stdout!.on("data", (b) => { out += String(b); }); child.stderr!.on("data", (b) => { err += String(b); });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
      });
      child.stdin!.end(input);
      try {
        const end = await ended;
        let doc: Record<string, any> = {};
        try { doc = JSON.parse(out.trim()); } catch { /* checked below */ }
        return { ...end, out, err, doc };
      } finally { clearTimeout(deadline); }
    }
    async function stop(child: ChildProcess): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    async function serve(fault: Fault): Promise<ChildProcess> {
      const child = launch(["daemon", "serve", ...homeFlags], fault);
      child.stdin!.end(); child.stdout!.resume(); child.stderr!.resume();
      for (let i = 0; i < 150 && child.exitCode === null && !existsSync(paths.socket); i++) await sleep(100);
      return child;
    }
    const daemon = await serve("healthy");
    try {
      const control = await call(["daemon", "status", ...homeFlags, "--json"], "healthy");
      if (control.code !== 0 || control.doc.result?.pid !== daemon.pid) throw new Error(`${name}: healthy daemon control failed: ${control.out} ${control.err}`);
      check(`${name} healthy status reaches the owned daemon`, true);
      for (const fault of ["preferences", "project-file", "parent-file", "removed-folder"] as const) {
        if (fault === "preferences") writeFileSync(preferences, `{${marker}`, { mode: 0o600 });
        try {
          const status = await call(["daemon", "status", ...homeFlags, "--json"], fault);
          check(`${name} ${fault} status reaches the same daemon`, status.code === 0 && status.doc.result?.pid === daemon.pid && status.doc.result?.state === "ready", { code: status.code, error: status.doc.error });
          for (const op of ["status", "about"]) {
            const bridge = await call(["daemon", "desktop", ...homeFlags], fault, JSON.stringify({ op }) + "\n");
            check(`${name} ${fault} desktop ${op} is framed and usable`, bridge.code === 0 && bridge.doc.v === 1 && bridge.doc.event === "result" && bridge.doc.ok === true && (op === "about" || bridge.doc.result?.pid === daemon.pid), { code: bridge.code, error: bridge.doc.error });
          }
          const negative = await call(fault === "preferences" ? ["ps", "--json"] : ["status", "--json"], fault);
          const code = fault === "preferences" ? "SCHEMA_INVALID" : fault === "removed-folder" ? "USAGE_INVALID" : "CONFLICT";
          check(`${name} ${fault} ordinary command retains its safety refusal`, negative.code !== 0 && negative.doc.error?.code === code, { code: negative.code, error: negative.doc.error });
          check(`${name} ${fault} unrelated bytes are unchanged`, readFileSync(join(fixture, "notes/.cotal"), "utf8") === marker && readFileSync(preferences, "utf8") === (fault === "preferences" ? `{${marker}` : valid));
        } finally { writeFileSync(preferences, valid, { mode: 0o600 }); }
      }
    } finally { await stop(daemon); }
    for (const fault of ["preferences", "project-file", "parent-file", "removed-folder"] as const) {
      if (fault === "preferences") writeFileSync(preferences, `{${marker}`, { mode: 0o600 });
      const child = await serve(fault);
      try {
        check(`${name} ${fault} foreground startup creates its endpoint`, child.exitCode === null && child.signalCode === null && existsSync(paths.socket), { exit: child.exitCode });
        if (child.exitCode === null && existsSync(paths.socket)) {
          const status = await call(["daemon", "status", ...homeFlags, "--json"], fault);
          check(`${name} ${fault} restarted daemon actually answers`, status.code === 0 && status.doc.result?.pid === child.pid, { code: status.code, error: status.doc.error });
        }
      } finally { await stop(child); writeFileSync(preferences, valid, { mode: 0o600 }); }
    }
    // Machine-home validation is independent of project context and remains mandatory.
    env.COTAL_HOME = "relative-home";
    const relative = await call(["daemon", "status", ...homeFlags, "--json"], "healthy");
    check(`${name} relative COTAL_HOME is still refused`, relative.doc.error?.code === "USAGE_INVALID");
  }
  console.log(`DAEMON STARTUP CONTEXT ${failed ? "FAILED" : "OK"} (${passed} passed, ${failed} failed)`);
  if (failed) process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL"); await closed;
    }
  }
  rmSync(root, { recursive: true, force: true });
}
