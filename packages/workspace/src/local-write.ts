import { CommandFailure } from "./output.js";

/** Report a failed local save at its destination, keeping storage errors separate from bad input.
 *  Call only where the requested save is known not to have completed. Unrecognized errors propagate. */
export function localWriteFailure(error: unknown, path: string, target: object = {}): CommandFailure {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const reasons: Record<string, { reason: string; remedy: string }> = {
    ENOSPC: { reason: "no space left on the device", remedy: "free space on the destination's filesystem, then retry" },
    EDQUOT: { reason: "the disk quota was exceeded", remedy: "free space or raise the disk quota, then retry" },
    EFBIG: { reason: "the file exceeds the filesystem or process file-size limit", remedy: "raise the file-size limit or shorten the content, then retry" },
  };
  const detail = code === undefined || !Object.hasOwn(reasons, code) ? undefined : reasons[code];
  if (!detail) throw error;
  return new CommandFailure("failed", "OPERATION_FAILED", `could not write ${path}: ${detail.reason} (${code}); the requested save did not complete`, {
    target: { ...target, path }, remedy: detail.remedy, native: { code }, cause: error,
  });
}
