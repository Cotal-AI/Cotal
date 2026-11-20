import { constants } from "node:os";
import { CommandFailure } from "./output.js";

/** Diagnose a known local storage failure so callers can add their own recovery steps. */
export function localWriteProblem(error: unknown): { code: string; reason: string; remedy: string } | undefined {
  const native = error as NodeJS.ErrnoException | null;
  // libuv may omit EDQUOT from its symbolic error table. On POSIX it still preserves -errno.
  const quota = constants.errno.EDQUOT;
  const code = process.platform !== "win32" && typeof quota === "number" && native?.errno === -quota ? "EDQUOT" : native?.code;
  const reasons: Record<string, { reason: string; remedy: string }> = {
    ENOSPC: { reason: "no space left on the device", remedy: "free space on the destination's filesystem" },
    EDQUOT: { reason: "the disk quota was exceeded", remedy: "free space or raise the disk quota" },
    EFBIG: { reason: "the file exceeds the filesystem or process file-size limit", remedy: "raise the file-size limit or shorten the content" },
  };
  if (code === undefined || !Object.hasOwn(reasons, code)) return undefined;
  return { code, ...reasons[code]! };
}

/** Report a failed local save at its destination, keeping storage errors separate from bad input.
 *  Call only where the requested save is known not to have completed. Unrecognized errors propagate. */
export function localWriteFailure(error: unknown, path: string, target: object = {}): CommandFailure {
  const problem = localWriteProblem(error);
  if (!problem) throw error;
  return new CommandFailure("failed", "OPERATION_FAILED", `could not write ${path}: ${problem.reason} (${problem.code}); the requested save did not complete`, {
    target: { ...target, path }, remedy: `${problem.remedy}, then retry`, native: { code: problem.code }, cause: error,
  });
}
