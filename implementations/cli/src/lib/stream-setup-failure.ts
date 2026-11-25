import type { ParsedArgs } from "@cotal-ai/core";
import { streamRecord, type CommandFailure } from "@cotal-ai/workspace";

/** Loose argument recovery can represent a missing value as true or an empty string. */
function setupSpace(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** A JSON history follow that refused before writing its snapshot. */
export function historySetupFailureRecords(args: ParsedArgs, failure: CommandFailure) {
  const first = args.positionals[0];
  const details = typeof failure.target === "object" && failure.target !== null ? failure.target : {};
  const target = {
    ...details,
    space: setupSpace("space" in details ? details.space : args.values.space),
    channel: first === undefined ? null : first.replace(/^#/, ""),
    dms: Boolean(args.values.dms),
  };
  return [
    streamRecord("history", "error", target, { code: failure.code, message: failure.message, ...(failure.remedy === undefined ? {} : { remedy: failure.remedy }) }),
    streamRecord("history", "end", target, { reason: "setup-failed" }),
  ];
}

/** A JSON membership follow that refused before writing its snapshot. */
export function membershipSetupFailureRecords(input: { space: unknown; channel: string | null }, failure: CommandFailure) {
  const target = { space: setupSpace(input.space), channel: input.channel };
  return [
    streamRecord("membership", "error", target, { code: failure.code, message: failure.message, ...(failure.remedy === undefined ? {} : { remedy: failure.remedy }) }),
    streamRecord("membership", "end", target, { reason: "setup-failed", lastAsOf: null }),
  ];
}

/** A JSON watch that refused before opening its view. */
export function watchSetupFailureRecords(args: ParsedArgs, failure?: CommandFailure, space?: string) {
  const target = {
    requestedSpace: setupSpace(args.values.space),
    ...(space === undefined ? {} : { space }),
  };
  const reason = failure ? { message: failure.message, ...(failure.remedy === undefined ? {} : { remedy: failure.remedy }) } : { message: "The observer could not establish its authorized view; this is not an empty successful snapshot." };
  return [
    streamRecord("watch", "error", target, { code: failure ? failure.code : "OPERATION_FAILED", ...reason }),
    streamRecord("watch", "end", target, { reason: "setup-failed" }),
  ];
}
