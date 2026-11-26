/**
 * The gateway half of a Hermes seat's command approvals (plugin/cotal/approvals.py): the adapter's
 * `send_exec_approval` sends each approval to the sidecar as an `approval` frame for a seat launched
 * with `askPermissions`, the owner's answer resolves it, and `post_approval_response` reports the
 * end of each wait the sidecar holds.
 *
 * The probe (plugin-approvals.probe.py) drives the real adapter and hooks over a stubbed
 * `resolve_gateway_approval` in the shape of each Hermes release, and prints what happened. This
 * side grades it.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const { check, finish } = createSuite();

const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) throw new Error("python is not on PATH, so the approvals cannot be verified");
const probe = fileURLToPath(new URL("./plugin-approvals.probe.py", import.meta.url));
const plugin = fileURLToPath(new URL("../plugin", import.meta.url));
const res = spawnSync(python, ["-I", probe, plugin], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH } });
const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
if (res.status !== 0 || !line) throw new Error(`the probe did not run:\n${res.stdout}\n${res.stderr}`);

type Frame = Record<string, unknown> & { id?: string };
type Ask = { success: boolean; error: string | null; frame: Frame | null };
const out = JSON.parse(line.slice("RESULT ".length)) as Record<string, unknown> & {
  off: Ask; full: Ask; no_permanent: Ask; no_session: Ask; smart_denied: Ask; down: Ask; old: Ask;
  resolved: Record<string, unknown>[]; down_resolved: Record<string, unknown>[]; old_resolved: Record<string, unknown>[];
  ends: Frame[]; down_ends: Frame[];
};

check("a seat that does not ask leaves the approval to the gateway's text prompt",
  out.off_buttons === false && out.off.success === false && out.off.frame === null && isDeepStrictEqual(out.off_noted, {}), out.off);
check("a seat that asks says it renders approvals, as Hermes 0.21 checks", out.on_buttons === true);
const f = out.full.frame!;
check("an approval goes to the sidecar as one frame, and the gateway hears it was sent", out.full.success === true && f.t === "approval");
check("the frame names the session, the command and Hermes's reason",
  f.session === "sk1" && f.command === "rm -rf build" && f.description === "recursive delete", f);
check("and the tool the approval stops, with its call, from the thread that runs it", f.tool === "execute_code" && f.toolCallId === "call-7", f);
check("it offers each of Hermes's choices, a deny note, and Hermes's own timeout",
  isDeepStrictEqual(f.choices, ["once", "session", "always", "deny"]) && f.note === true && f.timeoutMs === 60_000, f);
check("an approval with no tool noted is about the terminal, with no call", out.no_permanent.frame!.tool === "terminal" && !("toolCallId" in out.no_permanent.frame!), out.no_permanent.frame);
check("a pattern Hermes will not keep offers no Allow always", isDeepStrictEqual(out.no_permanent.frame!.choices, ["once", "session", "deny"]));
check("a session Hermes will not allow offers no Allow for this session", isDeepStrictEqual(out.no_session.frame!.choices, ["once", "always", "deny"]));
check("a smart-denied command offers only Allow once and Deny", isDeepStrictEqual(out.smart_denied.frame!.choices, ["once", "deny"]));
check("an answer resolves the session's approval with the choice, and a deny with the owner's note",
  isDeepStrictEqual(out.resolved, [{ session: "sk1", choice: "session", reason: null }, { session: "sk2", choice: "deny", reason: "Not the build folder." }]), out.resolved);
check("an answer to no open approval, or with a choice Hermes lacks, resolves nothing", out.resolved.length === 2);
check("the end of a wait is reported once, for an approval the sidecar holds",
  isDeepStrictEqual(out.ends, [{ t: "approval_end", session: "sk1", outcome: "session" }]), out.ends);
check("an approval that cannot reach the sidecar is denied at once with the cause",
  out.down.success === false && out.down_resolved.length === 1 && out.down_resolved[0]!.choice === "deny" && /sidecar is not connected/.test(String(out.down_resolved[0]!.reason)), out.down_resolved);
check("and its end is not reported, as the sidecar never held it", out.down_ends.length === 0, out.down_ends);
check("before Hermes 0.19 took a reason, Deny offers no note and none is passed",
  out.old.frame!.note === false && isDeepStrictEqual(out.old_resolved, [{ session: "sk6", choice: "deny" }]), out.old_resolved);
check("on Hermes 0.21 the timeout is read where it moved", out.new_timeout === 300_000, out.new_timeout);

finish();
