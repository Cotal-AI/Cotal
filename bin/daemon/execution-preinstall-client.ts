import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { validUpdateAdmission, type UpdateAdmission } from "@cotal-ai/workspace";
import type { ExecutionPreinstallRequest } from "./execution-preinstall.js";

export const PREINSTALL_PROGRESS = "COTAL_PREINSTALL_PROGRESS ";
// Allow the target's three-minute launch settlement and leave time for custody verification.
export const PREINSTALL_TIMEOUT_MS = 240_000;

export interface ExecutionPreinstallReceipt {
  readonly v: 1;
  readonly nonce: string;
  readonly installedEntry: string;
  readonly daemon?: { pid: number; start: string };
  readonly hostedSpaces: readonly string[];
  /** The count released updaters validate: the admission's, or 0 when the admission's is unknown. */
  readonly occupied: number;
  readonly admission: UpdateAdmission;
}

/** Execute only the retained package's declared check, with a bounded single identity-bound receipt. */
export async function targetExecutionPreinstall(root: string, installedEntry: string, daemonArgv: readonly string[], flags: Record<string, unknown>): Promise<ExecutionPreinstallReceipt> {
  const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { cotalPreinstall?: { v?: unknown; entry?: unknown } };
  if (meta.cotalPreinstall?.v !== 1 || typeof meta.cotalPreinstall.entry !== "string") throw new Error("target declares no supported read-only pre-install check; run its installer");
  const entry = realpathSync(join(root, meta.cotalPreinstall.entry));
  const rel = relative(realpathSync(root), entry);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("target pre-install entry escapes retained package");
  const request: ExecutionPreinstallRequest = { v: 1, nonce: randomBytes(16).toString("hex"), installedEntry, supportsExtendedLaunchWait: true,
    daemonArgv, flags: Object.fromEntries(Object.entries(flags).filter(([key, value]) => ["space", "server", "creds", "on"].includes(key) && typeof value === "string")),
  };
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, JSON.stringify(request)], { env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", failure = "", processed = 0;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => { child.kill("SIGTERM"); escalation ??= setTimeout(() => child.kill("SIGKILL"), 2000); };
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (failure) return;
      if (stream === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) { failure = "target pre-install output exceeded its limit"; terminate(); return; }
      if (stream === "stdout") for (let end = stdout.indexOf("\n", processed); end !== -1; end = stdout.indexOf("\n", processed)) {
        const line = stdout.slice(processed, end);
        processed = end + 1;
        if (line.startsWith(PREINSTALL_PROGRESS)) console.log(line.slice(PREINSTALL_PROGRESS.length).replace(/[\x00-\x1f\x7f]/g, ""));
      }
    };
    child.stdout.on("data", chunk => collect(chunk, "stdout"));
    child.stderr.on("data", chunk => collect(chunk, "stderr"));
    const timer = setTimeout(() => { failure = "target pre-install checks timed out"; terminate(); }, PREINSTALL_TIMEOUT_MS);
    const clear = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); };
    child.once("error", error => { clear(); reject(error); });
    child.once("close", status => { clear(); if (failure) reject(new Error(failure)); else resolve({ status, stdout, stderr }); });
  });
  if (result.status !== 0) throw new Error(`target pre-install checks refused: ${result.stderr.trim()}`);
  const receipts = result.stdout.split("\n").filter(line => line.startsWith("COTAL_PREINSTALL_RESULT "));
  if (receipts.length !== 1) throw new Error("target pre-install checks returned no unique result");
  const receipt = JSON.parse(receipts[0]!.slice("COTAL_PREINSTALL_RESULT ".length)) as ExecutionPreinstallReceipt;
  if (receipt.v !== 1 || receipt.nonce !== request.nonce || receipt.installedEntry !== installedEntry ||
      !Array.isArray(receipt.hostedSpaces) || receipt.hostedSpaces.some(space => typeof space !== "string") ||
      !validUpdateAdmission(receipt.admission) || receipt.occupied !== (receipt.admission.occupied ?? 0) || JSON.stringify(receipt.hostedSpaces) !== JSON.stringify(receipt.admission.hostedSpaces) ||
      receipt.daemon !== undefined && (!Number.isSafeInteger(receipt.daemon.pid) || receipt.daemon.pid <= 0 || typeof receipt.daemon.start !== "string" || !receipt.daemon.start))
    throw new Error("target pre-install checks returned invalid evidence");
  return receipt;
}
