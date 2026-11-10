import { CommandFailure } from "./output.js";

/** A capacity failure at a local write boundary. Callers name earlier changes when the operation is partial. */
export function localWriteFailure(error: unknown, path: string, opts: { target?: Record<string, unknown>; changed?: readonly unknown[] } = {}): CommandFailure | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const reason = code === "ENOSPC" ? "no space left on the device"
    : code === "EDQUOT" ? "the disk quota was exceeded"
    : code === "EFBIG" ? "the file-size limit was exceeded" : undefined;
  if (reason === undefined) return undefined;
  const partial = (opts.changed?.length ?? 0) > 0;
  return new CommandFailure(partial ? "partial" : "refused", partial ? "OPERATION_PARTIAL" : "TARGET_UNAVAILABLE", `cannot save ${path}: ${reason} (${code}); ${partial ? "earlier changes remain, and this file may be incomplete" : "nothing was written to the destination"}`, {
    target: { ...opts.target, path },
    native: { code },
    cause: error,
    ...(partial ? { changed: opts.changed } : {}),
    remedy: `free disk space or increase the ${code === "EFBIG" ? "file-size limit" : "disk quota"}, then ${partial ? "inspect the changed files before retrying" : "retry the command"}`,
  });
}
