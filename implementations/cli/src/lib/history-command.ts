import { resolve } from "node:path";
import { type ConnectFlags, type Connection } from "@cotal-ai/workspace";
import { targetWords } from "./confirmation-required.js";
import { shellWord } from "./endpoint-errors.js";

export type HistoryTarget = Pick<ConnectFlags, "space" | "server" | "creds">;

/** Pin the resolved space and keep explicit connection flags. When resolution used the project or
 *  a broker without a space flag, keep that form: adding a space could bypass local project trust. */
export function historyReadTarget(connection: Pick<Connection, "space" | "source">, flags: HistoryTarget): HistoryTarget {
  const { source, space } = connection;
  const usesImplicitSpace = source === "local-space" || source === "flag-server";
  return { space: usesImplicitSpace ? undefined : space, server: flags.server, creds: flags.creds ? resolve(flags.creds) : undefined };
}

/** Prefix the channel so the CLI reads it as a name, even when it matches a subcommand or option. */
export function channelHistoryCommand(channel: string, target: HistoryTarget): string {
  return `cotal history ${shellWord(`#${channel}`)}${targetWords(target)}`;
}
