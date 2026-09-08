/**
 * `cotal run`'s verb gate, with no broker: an invocation the dispatcher cannot route is refused
 * before any plane is opened, with the usage line and a non-zero exit, and the usage line names
 * every verb the gate accepts.
 *
 * This is the runtime package's own `test` script, which the Windows required job runs on a box
 * with no nats-server, so everything here must stay off the wire. Every other runtime suite drives
 * a real broker and lives in the smoke:ci chain.
 *
 * Run: pnpm smoke:runtime-run-command-usage   (no broker)
 */
import { runWorkflow } from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, extra ?? ""); }
};

// The gate refuses through `process.exit`; the suite turns that into a thrown sentinel so the
// exit code is graded rather than taken.
class Exited extends Error { constructor(readonly code: number | string | null | undefined) { super(`exit ${code}`); } }
const ERR: string[] = [];
const origErr = console.error;
const origExit = process.exit;
console.error = (...a: unknown[]) => { ERR.push(a.map(String).join(" ")); };
process.exit = ((code?: number | string | null) => { throw new Exited(code); }) as typeof process.exit;
const reset = () => { ERR.length = 0; };
const restore = () => { console.error = origErr; process.exit = origExit; };

const attempt = async (positionals: string[], values: Record<string, string | boolean> = {}): Promise<Exited | Error | undefined> =>
  runWorkflow({ values: { server: "nats://127.0.0.1:1", space: "usage", ...values }, positionals, raw: [] })
    .then(() => undefined, (e: Error) => e);

const VERBS = ["start", "resume", "ps", "journal", "answer"];

{
  reset();
  const got = await attempt([]);
  c("no verb at all is refused before any plane is opened", got instanceof Exited, got);
  c("with exit code 1", got instanceof Exited && got.code === 1, got);
  c("and the usage line on stderr", ERR.some((l) => l.startsWith("usage: cotal run")), ERR);
}

let usage = "";
{
  reset();
  const got = await attempt(["frobnicate"]);
  c("an unknown verb is refused the same way", got instanceof Exited && got.code === 1, got);
  usage = ERR.find((l) => l.startsWith("usage: cotal run")) ?? "";
  c("and the usage line is printed for it too", usage !== "", ERR);
}

// The gate and the usage text are two lists of the same verbs, kept by hand. Grade that they agree:
// every verb the gate routes appears in the usage the refusal prints.
for (const verb of VERBS) c(`the usage line names \`${verb}\``, usage.includes(verb), usage);

// Flags the HOSTED path does not take are refused by name before any plane is opened, never
// dropped: a hosted drive is recorded under the manager's own endpoint, the manager resumes from
// the recorded program, and it records the answerer from the caller's credential.
{
  reset();
  const got = await attempt(["start"], { file: "p.cotal.js", endpoint: "elsewhere" });
  c("hosted `start --endpoint` is refused", got instanceof Exited && got.code === 1 && ERR.some((l) => l.includes("--endpoint is not taken on the hosted path")), ERR);
  reset();
  const got2 = await attempt(["resume", "run-0"], { endpoint: "elsewhere" });
  c("hosted `resume --endpoint` is refused", got2 instanceof Exited && got2.code === 1 && ERR.some((l) => l.includes("--endpoint is not taken on the hosted path")), ERR);
  reset();
  const got3 = await attempt(["resume", "run-0"], { file: "p.cotal.js" });
  c("hosted `resume --file` is refused, and the sentence hands back a command with the run id in it",
    got3 instanceof Exited && got3.code === 1 && ERR.some((l) => l.includes("cotal run resume run-0 --local --file <program>")), ERR);
  reset();
  const got4 = await attempt(["answer", "run-0", "/checkpoint:approve#0"], { by: "dana" });
  c("hosted `answer --by` is refused: the manager records the caller", got4 instanceof Exited && got4.code === 1 && ERR.some((l) => l.includes("--by is not taken on the hosted path")), ERR);
  c("and the usage line advertises `--file` and `--by` only beside `--local`",
    usage.includes("resume <runId> [--local --file <program>]") && usage.includes("[--local --by <who>]") && !usage.includes("--by <who> [--value"), usage);
}

restore();
console.log(`run-command-usage: ${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
