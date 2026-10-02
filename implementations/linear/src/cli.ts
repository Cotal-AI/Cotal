/**
 * `cotal linear …`: operator commands over {@link LinearUpstream}. Every reply is printed as JSON so
 * the upstream's content, `structuredContent` and `isError` reach the reader unchanged; what the
 * server sent is untrusted data and is never interpreted here. Exit status: 0 for an MCP result
 * (including a tool result with `isError: true`), 2 for a refusal before dispatch, 3 for a protocol
 * error or a failure after dispatch.
 */
import { resolve } from "node:path";
import type { ParsedArgs } from "@cotal-ai/core";
import { assertAccountName, loadAccount, saveAccount, storedTokenPath } from "./account.js";
import { isLinearMode } from "./origin.js";
import { LinearUpstream, type UpstreamReply } from "./upstream.js";

export const USAGE = `cotal linear account add <name> --mode <write|readonly> (--token-stdin | --token-file <path>)
cotal linear account show <name>
cotal linear inventory <account> [--json]
cotal linear call <account> <tool> [--args <json>] [--inventory <digest>] [--timeout <ms>]
cotal linear resource <account> <uri> [--inventory <digest>] [--timeout <ms>]
cotal linear prompt <account> <name> [--args <json>] [--inventory <digest>] [--timeout <ms>]`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) fail("--token-stdin reads the token from a pipe, for example `cotal linear account add ro --mode readonly --token-stdin < token.txt`");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function jsonArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(String(raw));
  } catch (e) {
    fail(`--args is not JSON: ${(e as Error).message}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("--args must be a JSON object");
  return v as Record<string, unknown>;
}

function timeout(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) fail("--timeout must be a positive integer of milliseconds");
  return n;
}

function emit(reply: UpstreamReply): void {
  console.log(JSON.stringify(reply, null, 2));
  process.exitCode = reply.kind === "result" ? 0 : reply.kind === "refused" ? 2 : 3;
}

/** Run one request; SIGINT cancels it (reported as `unknown` once dispatched) and closes the session. */
async function withUpstream<T>(account: string, fn: (u: LinearUpstream, signal: AbortSignal) => Promise<T>): Promise<T> {
  const upstream = new LinearUpstream(loadAccount(account));
  const ctl = new AbortController();
  const onSignal = (): void => ctl.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await fn(upstream, ctl.signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await upstream.close();
  }
}

export async function linear(args: ParsedArgs): Promise<void> {
  const [sub, ...rest] = args.positionals;
  const v = args.values;
  switch (sub) {
    case "account": {
      const [action, name] = rest;
      if (!name) fail(USAGE);
      assertAccountName(name);
      if (action === "show") {
        console.log(JSON.stringify(loadAccount(name), null, 2));
        return;
      }
      if (action !== "add") fail(USAGE);
      const mode = v.mode;
      if (!isLinearMode(mode)) fail("--mode must be write or readonly");
      if (Boolean(v["token-stdin"]) === (v["token-file"] !== undefined)) fail("give exactly one of --token-stdin or --token-file");
      if (v["token-stdin"]) saveAccount({ name, mode, tokenFile: storedTokenPath(name) }, await readStdin());
      else saveAccount({ name, mode, tokenFile: resolve(String(v["token-file"])) });
      console.log(`saved Linear account ${name} (${mode})`);
      return;
    }
    case "inventory": {
      const [account] = rest;
      if (!account) fail(USAGE);
      const inv = await withUpstream(account, (u) => u.inventory());
      if (v.json) {
        console.log(JSON.stringify(inv, null, 2));
        return;
      }
      console.log(`endpoint   ${inv.endpoint} (${inv.mode})`);
      console.log(`server     ${inv.server.name ?? "?"} ${inv.server.version ?? ""}`.trimEnd());
      console.log(`digest     ${inv.digest}`);
      console.log(`tools      ${inv.tools.length}`);
      if (inv.resources) console.log(`resources  ${inv.resources.length} (+${inv.resourceTemplates?.length ?? 0} templates)`);
      if (inv.prompts) console.log(`prompts    ${inv.prompts.length}`);
      console.log(`discovery  ${inv.pages} pages, ${inv.bytes} bytes`);
      if (inv.unsupported.length) console.log(`unsupported ${inv.unsupported.join(", ")}`);
      for (const t of inv.tools) console.log(`  ${String(t.name)}`);
      return;
    }
    case "call": {
      const [account, tool] = rest;
      if (!account || !tool) fail(USAGE);
      const req = { name: tool, arguments: jsonArgs(v.args), inventoryDigest: v.inventory as string | undefined, timeoutMs: timeout(v.timeout) };
      emit(await withUpstream(account, (u, signal) => u.callTool({ ...req, signal })));
      return;
    }
    case "resource": {
      const [account, uri] = rest;
      if (!account || !uri) fail(USAGE);
      emit(await withUpstream(account, (u, signal) => u.readResource({ uri, inventoryDigest: v.inventory as string | undefined, timeoutMs: timeout(v.timeout), signal })));
      return;
    }
    case "prompt": {
      const [account, name] = rest;
      if (!account || !name) fail(USAGE);
      const a = jsonArgs(v.args);
      if (a && Object.values(a).some((x) => typeof x !== "string")) fail("prompt --args values must be strings");
      emit(await withUpstream(account, (u, signal) =>
        u.getPrompt({ name, arguments: a as Record<string, string> | undefined, inventoryDigest: v.inventory as string | undefined, timeoutMs: timeout(v.timeout), signal })));
      return;
    }
    default:
      fail(USAGE);
  }
}
