import { findSubcommand, type Command } from "@cotal-ai/core";
import { concreteChannelProblem, streamRecord, type CommandFailure, type StreamRecord } from "@cotal-ai/workspace";
import { metadataPositionals } from "../lib/command-path.js";

/** The refusal's argv may not parse. Only recognized switches outside operands select the stream. */
export function historyFollowFailureRecords(cmd: Command, words: readonly string[], failure: CommandFailure): StreamRecord[] | undefined {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const [first] = metadataPositionals(cmd, words, { refusal: { flags, values } }).positionals;
  if (!flags.has("follow") || !flags.has("json") || flags.has("plain") || findSubcommand(cmd, first?.value)) return;
  const channel = first?.value.replace(/^#/, "");
  const space = values.get("space");
  return historySetupFailureRecords({
    space: space?.trim() ? space : null,
    channel: channel && !concreteChannelProblem(channel) ? channel : null,
    dms: flags.has("dms"),
  }, failure);
}

/** A history follow refusal closes the stream even when it has no snapshot. */
export function historySetupFailureRecords(requested: { space: string | null; channel: string | null; dms: boolean }, failure: CommandFailure): StreamRecord[] {
  const target = failure.target ?? requested;
  const { code, message, remedy } = failure;
  return [
    streamRecord("history", "error", target, { code, message, ...(remedy === undefined ? {} : { remedy }) }),
    streamRecord("history", "end", target, { reason: "setup-failed" }),
  ];
}
