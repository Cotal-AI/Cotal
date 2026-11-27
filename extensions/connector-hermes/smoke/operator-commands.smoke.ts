/**
 * The commands a Hermes seat lists on its agent endpoint (plugin/cotal/commands.py): what the
 * gateway's own `/commands` lists for the operator chat. That is each gateway command Hermes makes
 * available on a gateway, each plugin command and each skill command, less the commands the
 * gateway's slash access would refuse the operator when they run.
 *
 * The probe (operator-commands.probe.py) answers the adapter's real `commands` request over a stubbed
 * Hermes registry, skill list and access policy, and prints the lists. This side grades them.
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
if (!python) throw new Error("python is not on PATH, so the command list cannot be verified");
const probe = fileURLToPath(new URL("./operator-commands.probe.py", import.meta.url));
const plugin = fileURLToPath(new URL("../plugin", import.meta.url));
const res = spawnSync(python, ["-I", probe, plugin], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH } });
const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
if (res.status !== 0 || !line) throw new Error(`the probe did not run:\n${res.stdout}\n${res.stderr}`);

type Entry = { name: string; target: string; description: string; inputHint?: string };
const out = JSON.parse(line.slice("RESULT ".length)) as {
  no_runner: string | null;
  open: Entry[];
  gated: Entry[];
  seen: { config: string; user: string; chat: string }[];
};
const names = (list: Entry[], target: string): string => list.filter((e) => e.target === target).map((e) => e.name).join(",");

check("without the gateway's runner the request fails, never an empty list", out.no_runner?.includes("no runner") === true, out.no_runner);
check("gateway commands are listed, a CLI-only one only when its config gate is on", names(out.open, "command") === "status,model,verbose,deploy", names(out.open, "command"));
check("a command carries its description and argument hint", JSON.stringify(out.open.find((e) => e.name === "model")) === JSON.stringify({ name: "model", target: "command", description: "Switch model", inputHint: "[model]" }), out.open);
check("a plugin command is listed with its hint", out.open.find((e) => e.name === "deploy")?.inputHint === "<env>", out.open);
check("each skill command is a skill, named without its slash", names(out.open, "skill") === "blank,release-notes" && out.open.find((e) => e.name === "release-notes")?.description === "Write release notes", out.open);
check("with slash access on, only the known commands the operator may run stay", names(out.gated, "command") === "status,deploy", names(out.gated, "command"));
check("slash access does not remove skills, as the gateway does not check it for them", names(out.gated, "skill") === "blank,release-notes", names(out.gated, "skill"));
check("access is read for the operator chat with the gateway's config", out.seen.length === 2 && out.seen.every((s) => s.config === "the-gateway-config" && s.user === "operator" && s.chat === "operator"), out.seen);

console.log(`hermes operator commands: ${pass} passed, ${fail} failed`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
