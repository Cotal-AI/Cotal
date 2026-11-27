import type { ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, inputDisabledByFlag, presentationOf } from "@cotal-ai/workspace";
import { assertAccountName } from "./account.js";
import { assertLinearEndpointName } from "./endpoint-name.js";
import { MAX_TIMEOUT_MS } from "./limits.js";
import { isLinearMode } from "./origin.js";

export const linearForms = [
  { path: ["account", "add"], operands: 1, flags: ["mode", "token-stdin", "token-file", "json", "plain"], outputs: ["json", "plain"], summary: "save an explicit token-file or piped-token account", reads: false, usage: "cotal linear account add <name> --mode <write|readonly> (--token-stdin | --token-file <path>)" },
  { path: ["account", "login"], operands: 1, flags: ["mode", "plain"], outputs: ["plain"], summary: "run the native interactive Linear OAuth flow", reads: false, usage: "cotal linear account login <name> --mode <write|readonly>" },
  { path: ["account", "show"], operands: 1, flags: ["json", "plain"], outputs: ["json", "plain"], summary: "read recorded account metadata without credential contents", reads: true, usage: "cotal linear account show <name>" },
  { path: ["inventory"], operands: 1, flags: ["json", "plain"], outputs: ["json", "plain"], summary: "read the complete bounded native MCP inventory", reads: true, usage: "cotal linear inventory <account> [--json]" },
  { path: ["call"], operands: 2, flags: ["args", "inventory", "timeout", "json", "plain"], outputs: ["json", "plain"], summary: "send one native tool request without replay", reads: false, usage: "cotal linear call <account> <tool> [--args <json>] [--inventory <digest>] [--timeout <ms>]" },
  { path: ["resource"], operands: 2, flags: ["inventory", "timeout", "json", "plain"], outputs: ["json", "plain"], summary: "read one native MCP resource without replay", reads: true, usage: "cotal linear resource <account> <uri> [--inventory <digest>] [--timeout <ms>]" },
  { path: ["prompt"], operands: 2, flags: ["args", "inventory", "timeout", "json", "plain"], outputs: ["json", "plain"], summary: "request one native MCP prompt without replay", reads: true, usage: "cotal linear prompt <account> <name> [--args <json>] [--inventory <digest>] [--timeout <ms>]" },
  { path: ["serve"], operands: 1, flags: ["endpoint", "space", "server"], outputs: [], summary: "legacy native foreground service; independent lifecycle uses the Linear service preset", reads: false, usage: "cotal linear serve <account> --endpoint <reverse-dns-name> [--space <s>] [--server <url>]" },
  { path: ["caller"], operands: 1, flags: ["endpoint", "out", "channels", "expires-in", "space", "server", "json", "plain"], outputs: ["json", "plain"], summary: "write a private native static caller without changing issuance authority", reads: false, usage: "cotal linear caller <name> --endpoint <reverse-dns-name> --out <path> [--channels <a,b>] [--expires-in <s>] [--space <s>] [--server <url>] [--json|--plain]" },
] as const;

export const USAGE = linearForms.map((form) => form.usage).join("\n");

/** The refusal of flags an operation does not take, naming them and the flags it does take. A
 *  format flag also names the output flags the operation has: `serve` has none, it reports as text. */
function foreignFlags(form: (typeof linearForms)[number], names: readonly string[]): CommandFailure {
  const operation = `linear ${form.path.join(" ")}`;
  const flags = (list: readonly string[]) => list.map((name) => `--${name}`).join(", ");
  const why = !names.some((name) => name === "json" || name === "plain") ? ""
    : form.outputs.length ? `, whose only output flag is ${flags(form.outputs)}`
    : ", a foreground service that reports as text and has no --json or --plain output";
  return new CommandFailure("refused", "USAGE_INVALID", `${flags(names)} does not belong to ${operation}${why}; no account or request was opened`, {
    remedy: `drop ${flags(names)}; ${operation} takes ${flags(form.flags)}: ${form.usage}`, selfContained: true,
  });
}

/** Pure grammar preflight. No account, token, OAuth state, connection or handler is opened. */
export function validateLinearArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (!args.positionals.length || args.positionals.length === 1 && args.positionals[0] === "account") {
    if (Object.keys(args.values).some((name) => !["json", "plain"].includes(name))) throw new CommandFailure("refused", "USAGE_INVALID", "choose a Linear operation before its options");
    return;
  }
  const form = linearForms.find((row) => row.path.every((word, index) => args.positionals[index] === word));
  if (!form || args.positionals.length !== form.path.length + form.operands) throw new CommandFailure("refused", "USAGE_INVALID", "choose one complete declared Linear operation and its required operands");
  const foreign = Object.keys(args.values).filter((name) => !(form.flags as readonly string[]).includes(name));
  if (foreign.length) throw foreignFlags(form, foreign);
  for (const operand of args.positionals.slice(form.path.length)) if (!operand || operand.length > 8192 || /[\u0000-\u001f\u007f]/u.test(operand)) throw new CommandFailure("refused", "USAGE_INVALID", "Linear operands must be bounded nonempty text without terminal controls");
  if (form.path[0] !== "caller") {
    try { assertAccountName(args.positionals[form.path.length]!); }
    catch { throw new CommandFailure("refused", "USAGE_INVALID", "the Linear account name must use 1 to 32 lowercase letters, digits or dashes and begin with a letter or digit"); }
  }
  if (form.path[0] === "account" && ["add", "login"].includes(args.positionals[1]!)) {
    if (!isLinearMode(args.values.mode)) throw new CommandFailure("refused", "USAGE_INVALID", "choose --mode write or readonly explicitly");
    if (args.positionals[1] === "add" && (args.values["token-stdin"] === true) === (args.values["token-file"] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "account add needs exactly one of --token-stdin or --token-file");
    if (args.positionals[1] === "login" && (inputDisabledByFlag() || process.env.COTAL_NO_PROMPT === "1")) throw new CommandFailure("refused", "USAGE_INVALID", "Linear OAuth login needs human authorization and cannot run with input disabled");
  }
  if (args.values.args !== undefined) {
    const value = jsonArgs(args.values.args);
    if (form.path[0] === "prompt" && value && Object.values(value).some((item) => typeof item !== "string")) throw new CommandFailure("refused", "USAGE_INVALID", "prompt argument values must be strings; no argument contents were printed");
  }
  timeout(args.values.timeout);
  if (form.path[0] === "serve" || form.path[0] === "caller") {
    try { if (typeof args.values.endpoint !== "string") throw new Error(); assertLinearEndpointName(args.values.endpoint); }
    catch { throw new CommandFailure("refused", "USAGE_INVALID", "choose --endpoint with the full native reverse-DNS Linear endpoint name"); }
    if (form.path[0] === "caller") {
      if (typeof args.values.out !== "string" || !args.values.out.trim() || /[\u0000-\u001f\u007f]/u.test(args.values.out)) throw new CommandFailure("refused", "USAGE_INVALID", "native Linear caller issuance requires --out with a private output path without terminal controls");
      if (args.values["expires-in"] !== undefined && (!/^[0-9]+$/.test(String(args.values["expires-in"])) || !Number.isSafeInteger(Number(args.values["expires-in"])) || Number(args.values["expires-in"]) <= 0)) throw new CommandFailure("refused", "USAGE_INVALID", "--expires-in must be a positive integer of native seconds");
    }
  }
}

export function jsonArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(String(raw));
  } catch {
    throw new CommandFailure("refused", "USAGE_INVALID", "--args must contain valid JSON; argument values were not printed");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new CommandFailure("refused", "USAGE_INVALID", "--args must be a JSON object");
  return v as Record<string, unknown>;
}

export function timeout(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_TIMEOUT_MS) throw new CommandFailure("refused", "USAGE_INVALID", `--timeout must be a positive integer of milliseconds, at most ${MAX_TIMEOUT_MS}`);
  return n;
}
