import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { collectLoadResult, LoadChildFailure, retainLoadFailure } from "./_callout-load-result.js";

const proofDir = process.env.CALLOUT_LOAD_PROOF_DIR;
const supervised = process.env.CALLOUT_LOAD_CUSTODY === "1";
const control = supervised ? createInterface({ input: process.stdin }) : undefined;
const commands = control?.[Symbol.asyncIterator]();
const root = mkdtempSync(join(proofDir ?? tmpdir(), "load-result-smoke-"));
const good = { clientSigning: "nats", attempts: 1, ok: 1, byReason: {}, latencies: [1], cpuMs: 1, loadMs: 1 };
const refused = { ...good, ok: 0, byReason: { denied: 1 }, latencies: [] };
const cases = [
  { name: "normal", output: `RESULT ${JSON.stringify(good)}\n`, exit: 0, accepted: true },
  { name: "expected-auth-refusal", output: `RESULT ${JSON.stringify(refused)}\n`, exit: 0, accepted: true },
  { name: "nonzero-after-result", output: `RESULT ${JSON.stringify(good)}\n`, exit: 7, accepted: false },
  { name: "signal-after-result", output: `RESULT ${JSON.stringify(good)}\n`, exit: null, accepted: false },
  { name: "missing", output: "no result\n", exit: 0, accepted: false },
  { name: "malformed", output: "RESULT {not-json\n", exit: 0, accepted: false },
  { name: "wrong-backend", output: 'RESULT {"clientSigning":"wrong"}\n', exit: 0, accepted: false },
  { name: "null-result", output: "RESULT null\n", exit: 0, accepted: false },
];
let checks = 0;
const rows: unknown[] = [];
try {
  for (const original of cases) {
    const cell = { ...original, output: `SYNTHETIC_PRIVATE_OUTPUT\n${original.output}` };
    const ending = cell.exit === null ? "process.kill(process.pid, 'SIGTERM')" : `process.exit(${cell.exit})`;
    const script = `process.stdin.once('data', () => process.stdout.write(${JSON.stringify(cell.output)}, () => setTimeout(() => ${ending}, 30)));`;
    const child = spawn(process.execPath, ["-e", script], { env: { PATH: process.env.PATH!, HOME: root, TMPDIR: root, COTAL_HOME: root }, stdio: ["pipe", "pipe", "pipe"] });
    const result = collectLoadResult<typeof good>(child, "nats").then(value => ({ accepted: true as const, value }), error => ({ accepted: false as const, error }));
    if (supervised) {
      const fields = readFileSync(`/proc/${child.pid}/stat`, "utf8").split(")").at(-1)!.trim().split(/\s+/);
      console.log(JSON.stringify({ phase: "child", pid: child.pid, birth: fields[19], parent: process.pid, case: cell.name }));
      assert.equal((await commands!.next()).value, "go");
    }
    child.stdin.end("go");
    const observed = await result;
    assert.equal(observed.accepted, cell.accepted, cell.name); checks++;
    if (observed.accepted) {
      assert.equal(observed.value.ok, cell.name === "expected-auth-refusal" ? 0 : 1); checks++;
      assert.equal(observed.value.pid, child.pid); checks++;
      rows.push({ name: cell.name, accepted: true, value: observed.value });
    } else {
      assert.ok(observed.error instanceof LoadChildFailure); checks++;
      const failure = observed.error as LoadChildFailure;
      assert.equal(Object.keys(failure).includes("outcome"), false); checks++;
      assert.equal(inspect(failure).includes("SYNTHETIC_PRIVATE_OUTPUT"), false); checks++;
      assert.equal(failure.outcome.exitCode, cell.exit); checks++;
      assert.equal(failure.outcome.signal, cell.exit === null ? "SIGTERM" : null); checks++;
      assert.equal(failure.outcome.output, cell.output); checks++;
      const file = retainLoadFailure(failure, root);
      assert.equal(statSync(file).mode & 0o777, 0o600); checks++;
      assert.equal(statSync(dirname(file)).mode & 0o777, 0o700); checks++;
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), failure.outcome); checks++;
      if (cell.name.endsWith("after-result")) { assert.deepEqual(failure.outcome.partialResult, good); checks++; }
      rows.push({ name: cell.name, accepted: false, outcome: failure.outcome, evidenceFile: file });
    }
  }
  if (proofDir) writeFileSync(join(proofDir, "RESULT.json"), `${JSON.stringify({ checks, rows, root, brokerStarted: false }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(supervised ? JSON.stringify({ phase: "done", checks, cases: cases.length }) : `callout-load result checks: ${checks}/${checks} passed`);
  if (!supervised) emitSentinel({ passed: checks, failed: 0 });
} finally {
  control?.close();
  if (!proofDir) rmSync(root, { recursive: true });
}
