// A real, lightweight agent for the seat-input smoke (seat-input-live.smoke.ts): joins the mesh
// exactly as e2e-stub.mjs does (so the manager's readiness fence resolves on a REAL presence
// registration and the seat appears in `ps`), and additionally APPENDS EVERY BYTE IT READS ON
// STDIN to the file named by COTAL_INPUT_SINK.
//
// The sink is the whole point. A smoke that graded the manager's `{name, bytes}` reply would be
// grading the manager's own arithmetic: it would stay green if the write never left the process,
// if node-pty dropped it, or if the bytes arrived mangled. The child writing down what it actually
// received is the only witness that can tell "the op reported 9 bytes" from "the harness got
// `/compact\r`" - which is the claim the feature makes.
//
// Written as raw bytes with no decoding, no trimming and no line buffering, because the assertions
// are byte-exact: a trailing `\r` present or absent is a cell, so a stub that normalised newlines
// would silently answer the question the test is asking.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { CotalEndpoint } from "@cotal-ai/core";

const e = process.env;
const sink = e.COTAL_INPUT_SINK;
if (!sink) throw new Error("COTAL_INPUT_SINK is required: without it this stub silently proves nothing");

// RAW MODE, because that is what a real seat's harness does and the difference is not cosmetic.
// A pty's line discipline is on by default, and in that cooked mode it does TWO things to what the
// manager writes: it maps the CR to an LF (ICRNL), and it HOLDS un-newlined text in the line buffer
// until a newline arrives, so `enter:false` text reaches the child only when something later
// presses Enter. Measured, not assumed: the first run of this suite showed the child receiving
// `hello\n` for a written `hello\r`, and never receiving a no-enter `part` at all. Every TUI
// harness this feature exists to drive (Claude Code, OpenCode, pi) puts its tty in raw mode, so a
// cooked-mode stub would grade bytes that no real seat ever sees. Raw mode delivers each byte
// verbatim and immediately, which is the contract the assertions here are written against.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
// Subscribe to stdin BEFORE the mesh join. The manager can only be told the seat is running after
// presence registers, so anything typed after that must find a reader already attached; wiring the
// reader afterwards would leave a window in which a delivered byte is legitimately lost and the
// suite would flake in the direction of a false red.
process.stdin.on("data", (chunk) => appendFileSync(sink, chunk));
process.stdin.resume();

// READINESS, and it is load-bearing rather than tidy. The manager puts a seat in its slot map (and
// therefore in `ps`) when it LAUNCHES the process, not when that process has finished booting, so a
// suite that waits for the `ps` row can type into a node process that has not yet run this file:
// the tty is still in cooked mode, ICRNL turns the written CR into an LF, and the byte-exact cell
// reds for a reason that has nothing to do with the product. Observed once in review, green on five
// re-runs, which is exactly the profile of a race CI would learn to ignore.
//
// The marker is a SEPARATE file, never a byte on the sink: the sink is compared byte for byte, so
// announcing readiness through it would corrupt the thing being measured.
if (e.COTAL_INPUT_READY) writeFileSync(e.COTAL_INPUT_READY, "ready");

const ep = new CotalEndpoint({
  space: e.COTAL_SPACE,
  servers: e.COTAL_SERVERS,
  creds: readFileSync(e.COTAL_CREDS, "utf8"),
  card: { id: e.COTAL_ID, name: e.COTAL_NAME, role: "worker", kind: "agent" },
  lifecycleUid: e.COTAL_LIFECYCLE_UID,
  channels: [],
  consume: false,
  registerPresence: true,
});
ep.on("error", (err) => console.error("STUB_ERR", err?.message ?? err));
await ep.start();
console.log("STUB_JOINED", e.COTAL_NAME, e.COTAL_ID);
const keep = setInterval(() => {}, 1 << 30);
const bye = () => { clearInterval(keep); ep.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
