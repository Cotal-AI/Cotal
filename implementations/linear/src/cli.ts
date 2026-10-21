/** Operator frontend over the native Linear client. No request or authority is substituted. */
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { acquireLock, credsClaims, writeSecretFileCreateOnly, type ParsedArgs, type SpaceAuth } from "@cotal-ai/core";
import { CommandFailure, recordOperationSpace, assertExternalCredentialExport, getSpaceAuth, hasUserAuthState, inputDisabledByFlag, isCommandFailure, presentationOf, protectedCredentialReference, protectedLocalDirectory, readLocalRecordSource, resolveMeshTarget, resolveNativeServiceTarget, workspaceSecretStore, writeResult, type MeshTarget, type Report } from "@cotal-ai/workspace";
import { assertAccountName, loadAccount, saveAccount, storedTokenPath } from "./account.js";
import { loginAccount } from "./oauth.js";
import { isLinearMode } from "./origin.js";
import { DEFAULT_LIMITS, LinearUpstream } from "./upstream.js";
import { emitInventory, emitUpstream } from "./presentation.js";
import { assertLinearEndpointName, provisionLinearCaller, registerLinearEndpoint, renewalDelayMs, runLinearEndpoint } from "./serve.js";

export const USAGE = `cotal linear account add <name> --mode <write|readonly> (--token-stdin | --token-file <path>)
cotal linear account login <name> --mode <write|readonly>
cotal linear account show <name>
cotal linear inventory <account> [--json]
cotal linear call <account> <tool> [--args <json>] [--inventory <digest>] [--timeout <ms>]
cotal linear resource <account> <uri> [--inventory <digest>] [--timeout <ms>]
cotal linear prompt <account> <name> [--args <json>] [--inventory <digest>] [--timeout <ms>]
cotal linear serve <account> --endpoint <reverse-dns-name> [--space <s>] [--server <url>]
cotal linear caller <name> --endpoint <reverse-dns-name> --out <path> [--channels <a,b>] [--expires-in <s>] [--space <s>] [--server <url>] [--json|--plain]`;

export const linearForms = [
  { path: ["account", "add"], operands: 1, flags: ["mode", "token-stdin", "token-file", "json", "plain"], outputs: ["json", "plain"], summary: "save an explicit token-file or piped-token account", reads: false },
  { path: ["account", "login"], operands: 1, flags: ["mode", "plain"], outputs: ["plain"], summary: "run the native interactive Linear OAuth flow", reads: false },
  { path: ["account", "show"], operands: 1, flags: ["json", "plain"], outputs: ["json", "plain"], summary: "read recorded account metadata without credential contents", reads: true },
  { path: ["inventory"], operands: 1, flags: ["json", "plain"], outputs: ["json", "plain"], summary: "read the complete bounded native MCP inventory", reads: true },
  { path: ["call"], operands: 2, flags: ["args", "inventory", "timeout", "json", "plain"], outputs: ["json", "plain"], summary: "send one native tool request without replay", reads: false },
  { path: ["resource"], operands: 2, flags: ["inventory", "timeout", "json", "plain"], outputs: ["json", "plain"], summary: "read one native MCP resource without replay", reads: true },
  { path: ["prompt"], operands: 2, flags: ["args", "inventory", "timeout", "json", "plain"], outputs: ["json", "plain"], summary: "request one native MCP prompt without replay", reads: true },
  { path: ["serve"], operands: 1, flags: ["endpoint", "space", "server"], outputs: [], summary: "legacy native foreground service; independent lifecycle uses the Linear service preset", reads: false },
  { path: ["caller"], operands: 1, flags: ["endpoint", "out", "channels", "expires-in", "space", "server", "json", "plain"], outputs: ["json", "plain"], summary: "write a private native static caller without changing issuance authority", reads: false },
] as const;

/** Pure grammar preflight. No account, token, OAuth state, connection or handler is opened. */
export function validateLinearArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (!args.positionals.length || args.positionals.length === 1 && args.positionals[0] === "account") {
    if (Object.keys(args.values).some((name) => !["json", "plain"].includes(name))) throw new CommandFailure("refused", "USAGE_INVALID", "choose a Linear operation before its options");
    return;
  }
  const form = linearForms.find((row) => row.path.every((word, index) => args.positionals[index] === word));
  if (!form || args.positionals.length !== form.path.length + form.operands) throw new CommandFailure("refused", "USAGE_INVALID", "choose one complete declared Linear operation and its required operands");
  if (Object.keys(args.values).some((name) => !(form.flags as readonly string[]).includes(name))) throw new CommandFailure("refused", "USAGE_INVALID", "a supplied flag does not belong to this Linear operation; no account or request was opened");
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

function accountForRead(name: string) {
  try { return loadAccount(name); }
  catch { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the selected Linear account metadata could not be read; no token or account-file contents were printed", { target: { account: name } }); }
}

function emitAccount(args: ParsedArgs, account: ReturnType<typeof loadAccount>, saved: boolean): void {
  writeResult(presentationOf(args.values), { command: "linear", target: { account: account.name }, result: { kind: saved ? "linear-account-saved" : "linear-account-metadata", name: account.name, mode: account.mode, auth: account.auth, credentialReference: account.auth === "token" ? account.tokenFile : null, nativeSave: saved ? "acknowledged" : "not-requested", credentialContentsReadForReport: false, upstreamChecked: false } }, (row): Report => ({ sections: [{ title: saved ? "Linear account save acknowledged" : "Recorded Linear account", blocks: [{ kind: "fields", rows: [["Account", row.name], ["Mode", row.mode], ["Authentication", row.auth], ["Credential reference", row.credentialReference ?? "private native OAuth state"], ["Upstream", "not checked"]] }, { kind: "lines", lines: ["This is recorded configuration, not proof of current upstream access. Credential contents are not printed. Native OAuth or token persistence retains its own authority and lifetime rules."] }] }] }));
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new CommandFailure("refused", "USAGE_INVALID", "--token-stdin requires a pipe; no secret should be typed into argv");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new CommandFailure("refused", "USAGE_INVALID", "the piped token exceeds 1 MiB; nothing was saved and no bytes were printed");
    chunks.push(bytes);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "the piped token is not UTF-8; nothing was saved and no bytes were printed"); }
}

function jsonArgs(raw: unknown): Record<string, unknown> | undefined {
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

function timeout(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0 || n > DEFAULT_LIMITS.maxTimeoutMs) throw new CommandFailure("refused", "USAGE_INVALID", `--timeout must be a positive integer of milliseconds, at most ${DEFAULT_LIMITS.maxTimeoutMs}`);
  return n;
}

/** Run one request; SIGINT cancels it (reported as `unknown` once dispatched) and closes the session. */
async function withUpstream<T>(account: string, fn: (u: LinearUpstream, signal: AbortSignal) => Promise<T>): Promise<T> {
  const upstream = new LinearUpstream(accountForRead(account));
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

async function forward(args: ParsedArgs, account: string, operation: string, run: (upstream: LinearUpstream, signal: AbortSignal) => Promise<import("./upstream.js").UpstreamReply>): Promise<void> {
  let reply: import("./upstream.js").UpstreamReply;
  try { reply = await withUpstream(account, run); }
  catch (error) { if (isCommandFailure(error)) throw error; throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the Linear request/session did not return a confirmed native outcome; the request was not retried", { target: { account, operation } }); }
  emitUpstream(args, account, operation, reply);
}

/** The static-auth mesh and the operator's own space authority, or a loud refusal. A per-user-auth
 *  mesh issues endpoint credentials through its remote auth service, which this package has no
 *  client for, so it is refused rather than signed locally. */
async function staticAuthority(v: Record<string, unknown>, root?: string): Promise<{ target: MeshTarget; auth: SpaceAuth }> {
  const target = resolveMeshTarget(root ?? process.cwd(), { space: v.space as string | undefined, server: v.server as string | undefined, readOnly: true });
  recordOperationSpace(target.space);
  if (root) resolveNativeServiceTarget(root, target.space, v.server as string | undefined);
  if (target.mode === "user" || hasUserAuthState(target.root, target.space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "Linear's native local issuer does not support per-user-auth spaces; no remote or broader caller was substituted", { target: { space: target.space } });
  if (target.mode !== "auth") throw new CommandFailure("refused", "UNSUPPORTED", "an open space has no static credential system for this native Linear action", { target: { space: target.space } });
  let auth: Awaited<ReturnType<typeof getSpaceAuth>>;
  try { auth = await getSpaceAuth(workspaceSecretStore(target.root), target.space); }
  catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected root's space authority could not be read; no native Linear authority action was submitted", { target: { space: target.space } }); }
  if (!auth) throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected root has no native static space authority; no other root was tried", { target: { space: target.space } });
  return { target, auth };
}

export interface LinearServeLifecycle {
  readonly root: string;
  readonly onInitialized: () => void | Promise<void>;
}

/** Register and serve until SIGINT/SIGTERM, renewing the serve credential at 75% of its life.
 *  The embedding callback observes initialization, not a current endpoint response or cleanup. */
export async function serveLinearAccount(account: string, endpoint: string, v: Record<string, unknown>, lifecycle?: LinearServeLifecycle): Promise<void> {
  const { target, auth } = await staticAuthority(v, lifecycle?.root);
  const upstream = new LinearUpstream(accountForRead(account));
  // Read the inventory first, so a broken account never becomes a registered endpoint.
  const inv = await upstream.inventory().catch(async (e: unknown) => {
    await upstream.close();
    if (lifecycle) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the selected native Linear account did not complete inventory discovery; no service registration was requested");
    fail(`the Linear account "${account}" did not answer discovery: ${(e as Error).message}`);
  });
  const reg = await registerLinearEndpoint({ auth, servers: target.server, space: target.space, tls: target.tlsRequired, endpoint }).catch(async (e: unknown) => {
    await upstream.close();
    if (lifecycle) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native Linear registration did not return a confirmed result; no new registration was retried");
    fail(`registering ${endpoint} failed: ${(e as Error).message}`);
  });
  // The record is READY from registration on, so a start that fails after it must take the record
  // back down rather than leave an advertised endpoint nobody serves.
  const handle = await runLinearEndpoint(reg.bundle, upstream).catch(async (e: unknown) => {
    // Reported as it happened: removed, failed, or still pending when the 10-second wait ran out.
    const removal = await Promise.race([
      reg.deregister().then(() => "its registration was removed", (d: unknown) => `its registration could not be removed (${(d as Error).message}) and still advertises this instance`),
      new Promise<string>((r) => setTimeout(() => r("its deregistration did not complete within 10 seconds and may still be pending; the record may still advertise this instance"), 10_000).unref()),
    ]);
    await upstream.close();
    if (lifecycle) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native Linear endpoint did not initialize; its original deregistration attempt was bounded and no registration was retried");
    fail(`${endpoint} did not start serving: ${(e as Error).message}; ${removal}`);
  });
  if (!lifecycle) console.log(`serving ${handle.endpoint} (instance ${handle.instanceId}, epoch ${handle.epoch}) for Linear account ${account} (${inv.mode}, ${inv.tools.length} tools, inventory ${inv.digest})`);
  let timer: NodeJS.Timeout | undefined;
  const schedule = (ms: number | undefined): void => {
    if (ms === undefined) return;
    timer = setTimeout(() => {
      reg.renew().then(
        (creds) => schedule(renewalDelayMs(creds)),
        (e: unknown) => {
          console.error(lifecycle ? "native Linear serve credential renewal failed; retaining its existing renewal policy" : `serve credential renewal failed (${(e as Error).message}); retrying in 30s`);
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
      console.error(lifecycle ? "native Linear deregistration did not confirm completion; inspect the original registration" : `deregistration failed (${(e as Error).message}); the record stays until the instance is registered again`));
    process.exit(code);
  };
  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
  if (lifecycle) {
    try { await lifecycle.onInitialized(); }
    catch { await stop(1); return; }
  }
  const err = await handle.closed;
  if (!stopping) {
    console.error(lifecycle ? "the native Linear serve connection closed; no replacement was started" : `the serve connection closed${err ? `: ${err.message}` : ""}`);
    await stop(1);
  }
}

async function caller(args: ParsedArgs, name: string, endpoint: string): Promise<void> {
  const v = args.values;
  const { target: mesh, auth } = await staticAuthority(v);
  const out = resolve(String(v.out)), target = { space: mesh.space, name, endpoint, path: out };
  assertExternalCredentialExport(out, [mesh.root]);
  protectedLocalDirectory(dirname(out));
  const held = acquireLock(`${out}.mint.lock`, { label: "Linear caller output", waitMs: 0, onTimeout: () => new CommandFailure("refused", "CONFLICT", "another writer holds the caller output", { target }) });
  let submitted = false;
  const changed: Array<Record<string, unknown>> = [];
  try {
    if (lstatSync(out, { throwIfNoEntry: false })) throw new CommandFailure("refused", "CONFLICT", "the selected caller output already exists; it was not replaced and no new caller was issued", { target });
    const channels = v.channels === undefined ? [] : String(v.channels).split(",").map((channel) => channel.trim()).filter(Boolean);
    submitted = true;
    const minted = await provisionLinearCaller(auth, { servers: mesh.server, space: mesh.space, tls: mesh.tlsRequired }, endpoint, { channels, ...(v["expires-in"] !== undefined ? { expiresInSeconds: Number(v["expires-in"]) } : {}) });
    changed.push({ kind: "native-caller-footprint", identity: minted.identity, lifecycleUid: minted.lifecycleUid, acknowledged: true });
    protectedLocalDirectory(dirname(out));
    writeSecretFileCreateOnly(out, minted.creds);
    changed.push({ kind: "private-caller-file", path: out, acknowledged: true });
    protectedCredentialReference(out);
    const current = readLocalRecordSource(out, 1024 * 1024, true);
    if (!current?.equals(Buffer.from(minted.creds, "utf8"))) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native caller file publication was acknowledged but its current private bytes could not be confirmed; issuance was not retried", { target, changed });
    const claims = credsClaims(minted.creds);
    const result = { kind: "linear-caller-written", name, space: mesh.space, endpoint, identity: minted.identity, lifecycleUid: minted.lifecycleUid, output: out, channels, expiresAt: claims.exp ?? null, nativeProvisioning: "acknowledged", secretOnStdout: false, seatStarted: false, managedSpawnSupport: false, changed };
    writeResult(presentationOf(v), { command: "linear", target, result }, (row): Report => ({ sections: [{ title: "Private Linear caller written", blocks: [{ kind: "fields", rows: [["Label", row.name], ["Space", row.space], ["Endpoint", row.endpoint], ["Identity", row.identity], ["Lifecycle", row.lifecycleUid], ["Private file", row.output], ["Expiry", row.expiresAt === null ? "not reported" : `${row.expiresAt} native Unix seconds`], ["Provisioning", row.nativeProvisioning], ["Seat", "not started"]] }, { kind: "lines", lines: ["The existing native issuer created its standalone agent footprint and exact Linear command grants. It adds no spawn, run or admin capability. Provisioning is not presence or completed work. Managed static spawns still refuse endpoint capabilities; this is not a generic caller/launch adapter. No credential bytes or environment-export onboarding were printed."] }] }] }));
  } catch (error) {
    if (!submitted && isCommandFailure(error)) throw error;
    if (!submitted) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the selected private caller destination could not be prepared; no caller issuance was submitted", { target });
    if (isCommandFailure(error) && error.outcome === "unknown") throw error;
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native caller provisioning or private publication did not confirm its final outcome; a caller footprint or output may exist. Issuance was not retried", { target, changed, remedy: "inspect this private output and any reported original identity/lifecycle before issuing another caller" });
  } finally { held.release(); }
}

export async function linear(args: ParsedArgs): Promise<void> {
  validateLinearArguments(args);
  const [sub, ...rest] = args.positionals;
  if (sub === undefined || sub === "account" && rest.length === 0) {
    const forms = sub === "account" ? linearForms.filter((form) => form.path[0] === "account") : linearForms;
    writeResult(presentationOf(args.values), { command: "linear", target: sub === "account" ? { group: "account" } : null, result: { kind: "linear-commands", operations: forms.map((form) => ({ path: [...form.path], summary: form.summary })), upstreamChecked: false } }, (row): Report => ({ sections: [{ title: "Linear", blocks: [{ kind: "commands", items: row.operations.map((form) => ({ command: `cotal linear ${form.path.join(" ")}`, description: form.summary })) }, { kind: "lines", lines: ["No account was opened, token read or upstream request sent."] }] }] }));
    return;
  }
  const v = args.values;
  switch (sub) {
    case "account": {
      const [action, name] = rest;
      if (!name) fail(USAGE);
      assertAccountName(name);
      if (action === "show") {
        emitAccount(args, accountForRead(name), false);
        return;
      }
      if (action === "login") {
        const mode = v.mode;
        if (!isLinearMode(mode)) fail("--mode must be write or readonly");
        try { await loginAccount(name, mode); }
        catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native Linear OAuth did not confirm its final local save; authorization or private state may have changed. Login was not retried", { target: { account: name } }); }
        emitAccount(args, { name, mode, auth: "oauth" }, true);
        return;
      }
      if (action !== "add") fail(USAGE);
      const mode = v.mode;
      if (!isLinearMode(mode)) fail("--mode must be write or readonly");
      if (Boolean(v["token-stdin"]) === (v["token-file"] !== undefined)) fail("give exactly one of --token-stdin or --token-file");
      const account = { name, mode, auth: "token" as const, tokenFile: v["token-stdin"] ? storedTokenPath(name) : resolve(String(v["token-file"])) };
      const token = v["token-stdin"] ? await readStdin() : undefined;
      try { saveAccount(account, token); }
      catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native Linear account save did not confirm completion; a private token or record may have changed. The save was not retried", { target: { account: name } }); }
      emitAccount(args, account, true);
      return;
    }
    case "inventory": {
      const [account] = rest;
      if (!account) fail(USAGE);
      let inventory: Awaited<ReturnType<LinearUpstream["inventory"]>>;
      try { inventory = await withUpstream(account, (u, signal) => u.inventory({ signal })); }
      catch (error) { if (isCommandFailure(error)) throw error; throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the complete bounded Linear inventory was not obtained; no partial inventory was presented as complete", { target: { account } }); }
      emitInventory(args, account, inventory);
      return;
    }
    case "call": {
      const [account, tool] = rest;
      if (!account || !tool) fail(USAGE);
      const req = { name: tool, arguments: jsonArgs(v.args), inventoryDigest: v.inventory as string | undefined, timeoutMs: timeout(v.timeout) };
      await forward(args, account, "call", (u, signal) => u.callTool({ ...req, signal }));
      return;
    }
    case "resource": {
      const [account, uri] = rest;
      if (!account || !uri) fail(USAGE);
      await forward(args, account, "resource", (u, signal) => u.readResource({ uri, inventoryDigest: v.inventory as string | undefined, timeoutMs: timeout(v.timeout), signal }));
      return;
    }
    case "prompt": {
      const [account, name] = rest;
      if (!account || !name) fail(USAGE);
      const a = jsonArgs(v.args);
      if (a && Object.values(a).some((x) => typeof x !== "string")) fail("prompt --args values must be strings");
      await forward(args, account, "prompt", (u, signal) =>
        u.getPrompt({ name, arguments: a as Record<string, string> | undefined, inventoryDigest: v.inventory as string | undefined, timeoutMs: timeout(v.timeout), signal }));
      return;
    }
    case "serve": {
      const [account] = rest;
      if (!account || typeof v.endpoint !== "string") fail(USAGE);
      await serveLinearAccount(account, v.endpoint, v as Record<string, unknown>);
      return;
    }
    case "caller": {
      const [name] = rest;
      if (!name || typeof v.endpoint !== "string") fail(USAGE);
      await caller(args, name, v.endpoint);
      return;
    }
    default:
      fail(USAGE);
  }
}
