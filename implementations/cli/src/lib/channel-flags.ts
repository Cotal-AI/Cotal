import { assertValidChannel, oneLine, resolveReadAcl } from "@cotal-ai/core";
import { CommandFailure, parseCommaList } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";

export function spawnReadAcl(subscribe: string[], allowed: string[] | undefined, remedy = "omit the conflicting channel override or choose subscriptions within the effective allowSubscribe list"): string[] {
  try { return resolveReadAcl(subscribe, allowed); }
  catch (error) { throw new CommandFailure("refused", "USAGE_INVALID", oneLine((error as Error).message), { remedy, selfContained: true }); }
}

/** Validate the declared entries. A stripped channel is only a suggestion, never a grant. */
export function parseChannelFlag(flag: string, value: string | undefined, selfContained?: true): string[] | undefined {
  return parseCommaList(value)?.map(channel => {
    try { return assertValidChannel(channel); }
    catch (error) {
      let remedy: string | undefined;
      if (channel.startsWith("#")) {
        try { remedy = `name the channel without its #, as ${shellWord(assertValidChannel(channel.replace(/^#+/, "")))}`; }
        catch { remedy = "provide a valid channel name or pattern without a leading #"; }
      }
      throw new CommandFailure("refused", "USAGE_INVALID", `${flag}: ${oneLine((error as Error).message)}`, { remedy, selfContained });
    }
  });
}
