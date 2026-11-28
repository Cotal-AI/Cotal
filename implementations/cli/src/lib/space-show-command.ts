import { codeSpan, type Presentation } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";
import { displayCmd } from "./self-exec.js";

/** A read of the named registration or prepared project, independent of the caller’s selection. */
export function showSpaceCommand(name: string, presentation: Presentation): string {
  const cli = presentation === "json" ? "cotal" : displayCmd({ fromAnyFolder: true });
  const format = presentation === "rich" ? "" : ` --${presentation}`;
  return codeSpan(`${cli} space show${name.startsWith("-") ? `${format} -- ${shellWord(name)}` : ` ${shellWord(name)}${format}`}`);
}
