import type { ParsedArgs } from "@cotal-ai/core";
import { streamRecord, type CommandFailure } from "@cotal-ai/workspace";

/** A JSON history follow that refused before writing its snapshot. */
export function historySetupFailureRecords(args: ParsedArgs, failure: CommandFailure) {
  const first = args.positionals[0];
  const target = {
    space: args.values.space ?? null,
    ...(typeof failure.target === "object" && failure.target !== null ? failure.target : {}),
    channel: first === undefined ? null : first.replace(/^#/, ""),
    dms: Boolean(args.values.dms),
  };
  return [
    streamRecord("history", "error", target, { code: failure.code, message: failure.message, ...(failure.remedy === undefined ? {} : { remedy: failure.remedy }) }),
    streamRecord("history", "end", target, { reason: "setup-failed" }),
  ];
}

/** A JSON membership follow that refused before writing its snapshot. */
export function membershipSetupFailureRecords(target: { space: string | null; channel: string | null }, failure: CommandFailure) {
  return [
    streamRecord("membership", "error", target, { code: failure.code, message: failure.message, ...(failure.remedy === undefined ? {} : { remedy: failure.remedy }) }),
    streamRecord("membership", "end", target, { reason: "setup-failed", lastAsOf: null }),
  ];
}
