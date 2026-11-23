/**
 * A reply in the gateway's operator chat that no model response carried, such as a slash command's
 * output, is written to the turn journal so the owner's turn shows it on the event plane. A reply the
 * model wrote is on the journal already as its responses, and is not written twice.
 *
 * The probe (operator-reply.probe.py) drives the real adapter, hooks and journal in the order the
 * gateway calls them, and prints each scenario's records. This side grades them.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`  x FAIL: ${name}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  }
};

const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) throw new Error("python is not on PATH, so the operator reply cannot be verified");
const probe = fileURLToPath(new URL("./operator-reply.probe.py", import.meta.url));
const plugin = fileURLToPath(new URL("../plugin", import.meta.url));
const res = spawnSync(python, ["-I", probe, plugin], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH } });
const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
if (res.status !== 0 || !line) throw new Error(`the probe did not run:\n${res.stdout}\n${res.stderr}`);

type Scenario = { records: { k: string; content?: string }[]; mesh: { target: Record<string, string>; text: string }[] };
const out = JSON.parse(line.slice("RESULT ".length)) as Record<string, Scenario>;
const kinds = (name: string): string => out[name]!.records.map((r) => (r.content === undefined ? r.k : `${r.k}:${r.content}`)).join(" | ");

check("a command turn's reply is journaled inside its processing", kinds("command") === "start | reply:Session: 3 messages | done", kinds("command"));
check("a model turn's reply is not journaled again", kinds("model") === "start | assistant:the answer | done", kinds("model"));
check("the next operator turn journals its reply again", kinds("after_model") === "start | reply:Model: claude | done", kinds("after_model"));
check("a peer's model call does not hide the operator's reply", kinds("peer_model") === "start | assistant:peer work | reply:Help text | done", kinds("peer_model"));
check("a model call on another platform does not hide it", kinds("other_platform") === "start | reply:Usage text | done", kinds("other_platform"));
check("a reply sent before the model runs is journaled, and the model's text once", kinds("ack_then_model") === "start | reply:Retrying | assistant:retried | done", kinds("ack_then_model"));
check("a reply in a peer's chat is not journaled", kinds("peer_chat") === "start | done", kinds("peer_chat"));
check("a reply in a peer's chat still goes to that peer", JSON.stringify(out.peer_chat!.mesh) === JSON.stringify([{ target: { peerId: "u_peer.ada" }, text: "hello ada" }]), out.peer_chat!.mesh);
check("the reply to a stop is neither journaled nor sent", kinds("stop_reply") === "start | done" && out.stop_reply!.mesh.length === 0, out.stop_reply);
check("a blank reply is not journaled", kinds("blank") === "start | done", kinds("blank"));
check("no operator reply reaches the mesh with a target", Object.values(out).every((s) => s.mesh.every((m) => m.target.peerId === "u_peer.ada" || Object.keys(m.target).length === 0)));

console.log(`hermes operator reply: ${pass} passed, ${fail} failed`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
