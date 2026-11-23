import type { Command, ParsedArgs } from "@cotal-ai/core";
import { checkServer, CommandFailure } from "@cotal-ai/workspace";

export function emptySpaceFlagFailure({ flags }: Pick<Command, "flags">, value: unknown): CommandFailure | undefined {
  // An explicitly empty space must not resolve to the selected one.
  const flag = flags?.find(({ name }) => name === "space");
  if (flag && typeof value === "string" && !value.trim())
    return new CommandFailure("refused", "USAGE_INVALID", `--space${flag.short ? `/-${flag.short}` : ""} is empty; name one space`, { remedy: "name the space; `cotal space` lists the spaces this machine knows" });
  return undefined;
}

export function brokerFlagFailure({ name, flags }: Pick<Command, "name" | "flags">, { server, file }: ParsedArgs["values"]): CommandFailure | undefined {
  if (!flags?.some(flag => flag.name === "server") || typeof server !== "string") return undefined;
  // Manifest up owns the single-listener rule. Check each entry before any manifest read or start.
  const servers = name === "up" && typeof file === "string" ? server.split(",").map(entry => entry.trim()) : [server];
  for (const entry of servers) {
    const checked = checkServer(entry, "--server");
    if (!checked.ok)
      return new CommandFailure("refused", "USAGE_INVALID", `${checked.message.replace(/^✗ /, "")}; the command did not run`, { remedy: checked.remedy, selfContained: true });
  }
  return undefined;
}
