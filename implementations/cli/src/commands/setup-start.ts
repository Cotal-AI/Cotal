import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Command, ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, canonicalRoot, identityRecord, loadManagerInstanceIdentity } from "@cotal-ai/workspace";
import { cliVersion } from "../lib/version.js";
import { selfArgv } from "../lib/self-exec.js";
import { checkLocalSpace } from "./space-registration.js";
import { up } from "./up.js";

type Coordinator = { pid: number; token: string | null };
export interface SetupStackStartResult {
  kind: "native-setup-stack-command";
  commandReturned: true;
  exitCode: 0;
  readinessEstablished: false;
  managerInstanceId: string;
  coordinator: Coordinator;
}

function validateChild(args: ParsedArgs): void {
  if (args.positionals.length || Object.keys(args.values).some((key) => !["root", "space", "expected-version"].includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", "setup startup requires only its explicit root, space and caller version");
  const root = args.values.root, space = args.values.space;
  if (typeof root !== "string" || !isAbsolute(root) || root.length > 4096 || /[\u0000-\u001f\u007f]/u.test(root) || typeof space !== "string" || !space) throw new CommandFailure("refused", "USAGE_INVALID", "setup startup requires its bounded absolute prepared root and explicit space");
  if (args.values["expected-version"] !== cliVersion()) throw new CommandFailure("refused", "CONFLICT", "setup and its native startup child are different CLI versions; no startup was attempted");
  let directory = false;
  try { directory = statSync(root).isDirectory(); }
  catch { /* Missing/unreadable project is a known pre-start refusal, not a crash. */ }
  if (!directory || canonicalRoot(process.cwd()) !== canonicalRoot(root) || checkLocalSpace(space, root, "--root", true) === "created") throw new CommandFailure("refused", "CONFLICT", "the setup preparation/root changed before startup; no replacement space was created");
}

/** Same verified CLI, same prepared local root, ordinary native up. No manifest, caller secret,
 *  remote replacement or alternate installation is selected by this internal composition. */
export const setupStartEntry: Command = {
  kind: "command", name: "__setup-start", hidden: true, prepareMeshTarget: false,
  summary: "start the explicitly prepared local space for setup",
  flags: ["root", "space", "expected-version"].map((name) => ({ name, type: "string" as const })),
  validate: validateChild,
  async run(args) {
    validateChild(args);
    await up({ values: { space: String(args.values.space), root: String(args.values.root), detach: true }, positionals: [], raw: [] });
  },
};

/** Native command completion is only a precondition. The caller must still obtain a real joined
 *  agent receipt, pinned to this root's manager. stdout/stderr are not parsed or echoed as proof. */
export async function startSetupLocalStack(root: string, space: string): Promise<SetupStackStartResult> {
  const [executable, ...self] = selfArgv();
  if (!executable) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the current verified CLI invocation is unavailable; no PATH replacement was used");
  const args = [...self, "__setup-start", "--root", root, "--space", space, "--expected-version", cliVersion()];
  const coordinator = await new Promise<Coordinator>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, args, { cwd: root, env: { ...process.env, COTAL_NO_PROMPT: "1" }, detached: true, stdio: "ignore", windowsHide: true }); }
    catch { reject(new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the native setup startup child could not be created; no other invocation was tried")); return; }
    let identity: Coordinator | undefined, settled = false;
    const finish = (error?: CommandFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      child.unref();
      if (error) reject(error); else if (identity) resolve(identity);
      else reject(new CommandFailure("unknown", "OPERATION_UNKNOWN", "the startup child returned without a usable original coordinator identity; no readiness was inferred"));
    };
    const unknown = (message: string) => new CommandFailure("unknown", "OPERATION_UNKNOWN", message, { target: { root, space, coordinator: identity ?? null }, remedy: "inspect the selected space and its recorded native processes before another startup; this command was not retried and no process was signalled" });
    const interrupt = () => finish(unknown("setup startup was interrupted; the native command and stack outcome remain unconfirmed"));
    const timer = setTimeout(() => finish(unknown("the native setup startup command did not return within its deadline; its coordinator was not killed or replaced")), 120000);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.once("spawn", () => {
      if (!child.pid) return;
      identity = { pid: child.pid, token: null };
      try {
        const record = identityRecord(child.pid);
        if ("token" in record) identity.token = record.token;
      } catch {
        // Display coordinates only. An unreadable start token never authorizes a signal.
      }
    });
    child.once("error", () => finish(identity ? unknown("the original startup coordinator reported an error after creation; its stack effects are unconfirmed") : new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the native startup coordinator was not created; no alternative executable was used")));
    child.once("exit", (code, signal) => finish(code === 0 && signal === null ? undefined : unknown("the native startup command did not return successfully; partial stack startup was not treated as no effect")));
  });
  const manager = loadManagerInstanceIdentity(root, space);
  if (!manager) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native up returned, but this root has no manager instance for a safe launch pin; no class or sibling fallback was used", { target: { root, space, coordinator }, remedy: "inspect the selected space and original startup before another attempt" });
  return { kind: "native-setup-stack-command", commandReturned: true, exitCode: 0, readinessEstablished: false, managerInstanceId: manager.instanceId, coordinator };
}
