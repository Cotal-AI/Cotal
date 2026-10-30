import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ChatHistoryChange, Command, ParsedArgs } from "@cotal-ai/core";
import { z } from "zod";
import { BOUNDARY_CODES, USAGE_CODES, CommandFailure, canonicalRoot, exitCode, identityRecord, isCommandFailure, loadManagerInstanceIdentity } from "@cotal-ai/workspace";
import { cliVersion } from "../lib/version.js";
import { selfArgv } from "../lib/self-exec.js";
import { checkLocalSpace } from "./space-registration.js";
import { chatHistoryMovedFailure, chatHistoryMovedThisRun, up } from "./up.js";

type Coordinator = { pid: number; token: string | null };
export interface SetupStackStartResult {
  kind: "native-setup-stack-command";
  commandReturned: true;
  exitCode: 0;
  readinessEstablished: false;
  managerInstanceId: string;
  coordinator: Coordinator;
  /** The chat history limit the start moved, when it moved one. */
  chatHistory?: ChatHistoryChange;
}

const startupFailure = z.strictObject({
  type: z.literal("setup-start-failure"),
  root: z.string().max(4096), space: z.string().max(512), pid: z.number().int().positive(),
  outcome: z.enum(["refused", "failed", "partial", "unknown"]),
  code: z.enum([...USAGE_CODES, ...BOUNDARY_CODES, "OPERATION_FAILED", "OPERATION_PARTIAL", "OPERATION_UNKNOWN"]),
  message: z.string().min(1).max(8192), remedy: z.string().max(8192).optional(),
});

const historyLimit = z.strictObject({ maxAgeMs: z.number().nonnegative(), perSender: z.number().int() });
/** The child's report that its stream setup moved the chat history limit. It is sent before the
 *  child returns or sends its failure, because the parent reads none of the child's output. */
const chatHistoryMove = z.strictObject({
  type: z.literal("setup-start-chat-history"),
  root: z.string().max(4096), space: z.string().max(512), pid: z.number().int().positive(),
  stream: z.string().max(512), from: historyLimit, to: historyLimit,
});

/** Tell setup that this start moved the chat history limit, whether the start then fails or returns. */
async function reportChatHistoryMove(args: ParsedArgs): Promise<void> {
  const moved = chatHistoryMovedThisRun();
  if (!moved || !process.send || !process.connected) return;
  const report = chatHistoryMove.parse({ type: "setup-start-chat-history", root: args.values.root, space: args.values.space, pid: process.pid, ...moved.change });
  await new Promise<void>((resolve) => process.send!(report, () => resolve()));
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
    try {
      validateChild(args);
      await up({ values: { space: String(args.values.space), root: String(args.values.root), detach: true }, positionals: [], raw: [] });
    } catch (error) {
      await reportChatHistoryMove(args);
      // Flush only classified command diagnostics. Raw exceptions and native detail bodies stay private.
      if (isCommandFailure(error) && process.send && process.connected) {
        const receipt = startupFailure.safeParse({ type: "setup-start-failure", root: args.values.root, space: args.values.space, pid: process.pid, outcome: error.outcome, code: error.code, message: error.message, ...(error.remedy ? { remedy: error.remedy } : {}) });
        if (receipt.success) await new Promise<void>((resolve) => process.send!(receipt.data, () => resolve()));
      }
      throw error;
    }
    await reportChatHistoryMove(args);
  },
};

/** Native command completion is only a precondition. The caller must still obtain a real joined
 *  agent receipt, pinned to this root's manager. stdout/stderr are not parsed or echoed as proof. */
export async function startSetupLocalStack(root: string, space: string): Promise<SetupStackStartResult> {
  const [executable, ...self] = selfArgv();
  if (!executable) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the current verified CLI invocation is unavailable; no PATH replacement was used");
  const args = [...self, "__setup-start", "--root", root, "--space", space, "--expected-version", cliVersion()];
  // The move the child reports. The broker deleted the posts older than the new age at the move, so
  // a failure after it says so.
  let moved: ChatHistoryChange | undefined;
  const failed = (error: CommandFailure) => moved ? chatHistoryMovedFailure(error, { space, change: moved }) : error;
  const coordinator = await new Promise<Coordinator>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, args, { cwd: root, env: { ...process.env, COTAL_NO_PROMPT: "1" }, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true }); }
    catch { reject(new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the native setup startup child could not be created; no other invocation was tried")); return; }
    let identity: Coordinator | undefined, settled = false;
    let receipt: z.infer<typeof startupFailure> | undefined, invalidReceipt = false;
    const finish = (error?: CommandFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(failed(error)); else if (identity) resolve(identity);
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
    // The child sends a move before its failure receipt or clean exit. A valid move stays through
    // either one; only a second move, a move after the receipt, or another root, space or pid is invalid.
    child.on("message", (message) => {
      const move = chatHistoryMove.safeParse(message);
      if (move.success) {
        if (moved || receipt || move.data.root !== root || move.data.space !== space || move.data.pid !== child.pid) invalidReceipt = true;
        else moved = { stream: move.data.stream, from: move.data.from, to: move.data.to };
        return;
      }
      const parsed = startupFailure.safeParse(message);
      if (!parsed.success || receipt || parsed.data.root !== root || parsed.data.space !== space || parsed.data.pid !== child.pid) invalidReceipt = true;
      else receipt = parsed.data;
    });
    // Close follows the IPC channel closing, so a flushed failure is read before classification.
    child.once("close", (code, signal) => {
      if (!invalidReceipt && receipt && signal === null) {
        try {
          if (exitCode(receipt.outcome, receipt.code) === code) {
            finish(new CommandFailure(receipt.outcome, receipt.code, receipt.message, { target: { root, space, coordinator: identity ?? null }, ...(receipt.remedy ? { remedy: receipt.remedy } : {}) }));
            return;
          }
        } catch { /* An inconsistent classification is not a confirmed native result. */ }
      }
      finish(code === 0 && signal === null && !receipt && !invalidReceipt ? undefined : unknown("the native startup command did not return a matching classified result; partial stack startup was not treated as no effect"));
    });
  });
  let manager: ReturnType<typeof loadManagerInstanceIdentity>;
  try { manager = loadManagerInstanceIdentity(root, space); }
  catch { throw failed(new CommandFailure("unknown", "OPERATION_UNKNOWN", "native up returned, but this root's manager instance identity does not read; no readiness was inferred", { target: { root, space, coordinator }, remedy: "inspect the selected space and original startup before another attempt" })); }
  if (!manager) throw failed(new CommandFailure("unknown", "OPERATION_UNKNOWN", "native up returned, but this root has no manager instance for a safe launch pin; no class or sibling fallback was used", { target: { root, space, coordinator }, remedy: "inspect the selected space and original startup before another attempt" }));
  return { kind: "native-setup-stack-command", commandReturned: true, exitCode: 0, readinessEstablished: false, managerInstanceId: manager.instanceId, coordinator, ...(moved ? { chatHistory: moved } : {}) };
}
