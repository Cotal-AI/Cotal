/**
 * `cotal linear …`: operator commands over {@link LinearUpstream}. Every reply is printed as JSON so
 * the upstream's content, `structuredContent` and `isError` reach the reader unchanged; what the
 * server sent is untrusted data and is never interpreted here. Exit status: 0 for an MCP result
 * (including a tool result with `isError: true`), 2 for a refusal before dispatch, 3 for a protocol
 * error or a failure after dispatch.
 */
import { resolve } from "node:path";
import { writeSecretFileCreateOnly, type ParsedArgs, type SpaceAuth } from "@cotal-ai/core";
import { getSpaceAuth, hasUserAuthState, resolveMeshTarget, workspaceSecretStore, type MeshTarget } from "@cotal-ai/workspace";
import { assertAccountName, loadAccount, saveAccount, storedTokenPath } from "./account.js";
import { loginAccount } from "./oauth.js";
import { isLinearMode } from "./origin.js";
import { LinearUpstream, type UpstreamReply } from "./upstream.js";
import { provisionLinearCaller, registerLinearEndpoint, renewalDelayMs, runLinearEndpoint } from "./serve.js";

export const USAGE = `cotal linear account add <name> --mode <write|readonly> (--token-stdin | --token-file <path>)
cotal linear account login <name> --mode <write|readonly>
cotal linear account show <name>
cotal linear inventory <account> [--json]
cotal linear call <account> <tool> [--args <json>] [--inventory <digest>] [--timeout <ms>]
cotal linear resource <account> <uri> [--inventory <digest>] [--timeout <ms>]
cotal linear prompt <account> <name> [--args <json>] [--inventory <digest>] [--timeout <ms>]
cotal linear serve <account> --endpoint <reverse-dns-name> [--space <s>] [--server <url>]
cotal linear caller <name> --endpoint <reverse-dns-name> --out <path> [--channels <a,b>] [--expires-in <s>] [--space <s>] [--server <url>]`;

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

/** The static-auth mesh and the operator's own space authority, or a loud refusal. A per-user-auth
 *  mesh issues endpoint credentials through its remote auth service, which this package has no
 *  client for, so it is refused rather than signed locally. */
async function staticAuthority(v: Record<string, unknown>): Promise<{ target: MeshTarget; auth: SpaceAuth }> {
  const target = resolveMeshTarget(process.cwd(), { space: v.space as string | undefined, server: v.server as string | undefined });
  if (target.mode === "user" || hasUserAuthState(target.root, target.space))
    fail(`"${target.space}" is a per-user-auth mesh: its endpoint credentials come from the remote auth service, which \`cotal linear\` does not support yet. Nothing was registered or minted.`);
  if (target.mode !== "auth") fail(`"${target.space}" is an open mesh: there is no credential system to scope a Linear endpoint or its callers. Use a static-auth mesh.`);
  const auth = await getSpaceAuth(workspaceSecretStore(target.root), target.space);
  if (!auth) fail(`no space authority for "${target.space}" under ${target.root}; run this where the mesh was set up`);
  return { target, auth };
}

/** Register and serve until SIGINT/SIGTERM, renewing the serve credential at 75% of its life. */
async function serve(account: string, endpoint: string, v: Record<string, unknown>): Promise<void> {
  const { target, auth } = await staticAuthority(v);
  const upstream = new LinearUpstream(loadAccount(account));
  // Read the inventory first, so a broken account never becomes a registered endpoint.
  const inv = await upstream.inventory().catch(async (e: unknown) => {
    await upstream.close();
    fail(`the Linear account "${account}" did not answer discovery: ${(e as Error).message}`);
  });
  const reg = await registerLinearEndpoint({ auth, servers: target.server, space: target.space, tls: target.tlsRequired, endpoint }).catch(async (e: unknown) => {
    await upstream.close();
    fail(`registering ${endpoint} failed: ${(e as Error).message}`);
  });
  // The record is READY from registration on, so a start that fails after it must take the record
  // back down rather than leave an advertised endpoint nobody serves.
  const handle = await runLinearEndpoint(reg.bundle, upstream).catch(async (e: unknown) => {
    await Promise.race([reg.deregister(), new Promise((r) => setTimeout(r, 10_000).unref())]).catch((d: unknown) =>
      console.error(`deregistration failed (${(d as Error).message}); the record stays until the instance is registered again`));
    await upstream.close();
    fail(`${endpoint} did not start serving: ${(e as Error).message}; its registration was removed`);
  });
  console.log(`serving ${handle.endpoint} (instance ${handle.instanceId}, epoch ${handle.epoch}) for Linear account ${account} (${inv.mode}, ${inv.tools.length} tools, inventory ${inv.digest})`);
  let timer: NodeJS.Timeout | undefined;
  const schedule = (ms: number | undefined): void => {
    if (ms === undefined) return;
    timer = setTimeout(() => {
      reg.renew().then(
        (creds) => schedule(renewalDelayMs(creds)),
        (e: unknown) => {
          console.error(`serve credential renewal failed (${(e as Error).message}); retrying in 30s`);
          schedule(30_000);
        },
      );
    }, ms);
  };
  schedule(renewalDelayMs(reg.bundle.creds()));
  let stopping = false;
  const stop = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    await handle.stop(10_000);
    await Promise.race([reg.deregister(), new Promise((r) => setTimeout(r, 10_000).unref())]).catch((e: unknown) =>
      console.error(`deregistration failed (${(e as Error).message}); the record stays until the instance is registered again`));
    process.exit(code);
  };
  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
  const err = await handle.closed;
  if (!stopping) {
    console.error(`the serve connection closed${err ? `: ${err.message}` : ""}`);
    await stop(1);
  }
}

async function caller(name: string, endpoint: string, v: Record<string, unknown>): Promise<void> {
  if (v.out === undefined) fail("--out <path> is required: the credential is written there 0600 and never printed");
  const { target, auth } = await staticAuthority(v);
  const channels = v.channels === undefined ? [] : String(v.channels).split(",").map((c) => c.trim()).filter(Boolean);
  const expires = v["expires-in"] === undefined ? undefined : Number(v["expires-in"]);
  if (expires !== undefined && (!Number.isSafeInteger(expires) || expires <= 0)) fail("--expires-in must be a positive integer of seconds");
  const out = resolve(String(v.out));
  const minted = await provisionLinearCaller(auth, { servers: target.server, space: target.space, tls: target.tlsRequired }, endpoint, {
    channels, ...(expires !== undefined ? { expiresInSeconds: expires } : {}),
  });
  writeSecretFileCreateOnly(out, minted.creds);
  console.log(`minted Linear caller "${name}" for ${endpoint} on ${target.space}: identity ${minted.identity}`);
  console.log(`  credential   ${out} (0600)`);
  console.log(`  lifecycle    ${minted.lifecycleUid}`);
  console.log(`  launch a hand-driven seat with COTAL_SERVERS=${target.server} COTAL_SPACE=${target.space} COTAL_NAME=${name} COTAL_CREDS=${out} COTAL_LIFECYCLE_UID=${minted.lifecycleUid}`);
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
      if (action === "login") {
        const mode = v.mode;
        if (!isLinearMode(mode)) fail("--mode must be write or readonly");
        await loginAccount(name, mode);
        console.log(`saved Linear account ${name} (${mode}, oauth)`);
        return;
      }
      if (action !== "add") fail(USAGE);
      const mode = v.mode;
      if (!isLinearMode(mode)) fail("--mode must be write or readonly");
      if (Boolean(v["token-stdin"]) === (v["token-file"] !== undefined)) fail("give exactly one of --token-stdin or --token-file");
      if (v["token-stdin"]) saveAccount({ name, mode, auth: "token", tokenFile: storedTokenPath(name) }, await readStdin());
      else saveAccount({ name, mode, auth: "token", tokenFile: resolve(String(v["token-file"])) });
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
    case "serve": {
      const [account] = rest;
      if (!account || typeof v.endpoint !== "string") fail(USAGE);
      await serve(account, v.endpoint, v as Record<string, unknown>);
      return;
    }
    case "caller": {
      const [name] = rest;
      if (!name || typeof v.endpoint !== "string") fail(USAGE);
      await caller(name, v.endpoint, v as Record<string, unknown>);
      return;
    }
    default:
      fail(USAGE);
  }
}
