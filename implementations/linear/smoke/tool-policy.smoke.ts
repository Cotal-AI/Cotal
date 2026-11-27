import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CotalEndpoint, createSpaceAuth, EpEnvelopeError, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { LinearUpstream, loadAccount, registerLinearEndpoint, provisionLinearCaller, runLinearEndpoint } from "../src/index.js";
import { linear } from "../src/cli.js";
import { linearDir, oauthStatePath, saveAccount } from "../src/account.js";
import { LINEAR_MCP_ORIGIN } from "../src/origin.js";

const home = mkdtempSync(join(tmpdir(), "linear-policy-"));
const cotalHome = join(home, "cotal");
process.env.COTAL_HOME = cotalHome;
process.env.HOME = home;
let passed = 0, failed = 0;
function check(name: string, value: boolean): void {
  if (value) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}`); }
}
const calls: string[] = [];
let tokenExchanges = 0;
let managedRequests = 0;
const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  if (url.searchParams.has("managed-fixture")) managedRequests++;
  const path = url.pathname;
  const json = (value: unknown): void => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value)); };
  if (path.includes("oauth-protected-resource")) return json({ resource: `${LINEAR_MCP_ORIGIN}/mcp`, authorization_servers: [LINEAR_MCP_ORIGIN] });
  if (path.includes("oauth-authorization-server") || path.includes("openid-configuration")) return json({ issuer: LINEAR_MCP_ORIGIN,
    authorization_endpoint: `${LINEAR_MCP_ORIGIN}/authorize`, token_endpoint: `${LINEAR_MCP_ORIGIN}/token`, registration_endpoint: `${LINEAR_MCP_ORIGIN}/register`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"] });
  let body = "";
  for await (const part of req) body += part;
  if (path === "/register") return json({ ...JSON.parse(body), client_id: "local-client" });
  if (path === "/token") { tokenExchanges++; return json({ access_token: "local-access", refresh_token: "local-refresh", token_type: "Bearer", expires_in: 3600 }); }
  if (req.method !== "POST") { res.writeHead(req.method === "DELETE" ? 200 : 405).end(); return; }
  const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; protocolVersion?: string } };
  if (message.id === undefined) { res.writeHead(202).end(); return; }
  const rpc = (result: unknown) => json({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") return rpc({ protocolVersion: message.params?.protocolVersion, serverInfo: { name: "local-linear", version: "1" }, capabilities: { tools: {} } });
  if (message.method === "tools/list") return rpc({ tools: ["read_issue", "delete_issue"].map(name => ({ name, inputSchema: { type: "object" } })) });
  if (message.method === "tools/call") { calls.push(message.params?.name ?? ""); return rpc({ content: [{ type: "text", text: "local-result" }] }); }
  res.writeHead(400).end();
});
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const local = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const logical = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
  if (logical.origin !== LINEAR_MCP_ORIGIN) throw new Error("unexpected upstream origin");
  return nativeFetch(local + logical.pathname + logical.search, init);
};
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const space = "linearpolicy", servers = `nats://127.0.0.1:${port}`, endpoint = "test.example.linear";
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" } }), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
let running: Awaited<ReturnType<typeof runLinearEndpoint>> | undefined;
let registration: Awaited<ReturnType<typeof registerLinearEndpoint>> | undefined;
let caller: CotalEndpoint | undefined;
const upstreams: LinearUpstream[] = [];
const tokenFile = join(home, "control.token");
writeFileSync(tokenFile, "local-control\n", { mode: 0o600 });
const record = join(linearDir(), "limited.json");

function repairAccount(name: string): void {
  writeFileSync(join(linearDir(), `${name}.json`), JSON.stringify({ name, mode: "write", auth: "oauth", allowedTools: ["read_issue"] }), { mode: 0o600 });
}

function repairNamed(error: unknown, path: string): boolean {
  const { remedy } = (error ?? {}) as { remedy?: string };
  return String(error).includes(path) && remedy?.includes(JSON.stringify(path)) === true && remedy.includes("`allowedTools`");
}

async function waitForRestartedEndpoint(caller: CotalEndpoint): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const { reply } = await caller.invokeService(endpoint, "inventory", {}, { deadlineMs: Math.max(1, deadline - Date.now()) });
      if (!reply.ok) throw new Error(`restarted Linear inventory failed: ${reply.error.message}`);
      return;
    } catch (error) {
      if (!(error instanceof EpEnvelopeError) || error.code !== "unavailable" || error.outcome !== "not-executed"
        || !error.message.startsWith("no responder for ") || Date.now() >= deadline) throw error;
      await wait(20);
    }
  }
}

async function managedToolPolicy(): Promise<void> {
  const root = join(home, "project");
  mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
  saveSpaceAuth(authDir(root), auth);
  recordMesh({ space, server: servers, root, mode: "auth", origin: "up", ts: new Date().toISOString() });
  const managedEndpoint = "test.example.managed-linear";
  const hook = join(home, "local-linear.mjs");
  writeFileSync(hook, `const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== ${JSON.stringify(LINEAR_MCP_ORIGIN)}) throw new Error("unexpected upstream origin");
  url.searchParams.set("managed-fixture", "1");
  return nativeFetch(${JSON.stringify(local)} + url.pathname + url.search, init);
};\n`, { mode: 0o600 });
  const run = promisify(execFile);
  const bin = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
  const extension = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js")).href;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
    COTAL_HOME: cotalHome,
    COTAL_SKIP_CONNECTOR_SEED: "1",
  };
  const service = async (...args: string[]) => {
    const result = await run(process.execPath, ["--import", pathToFileURL(hook).href, "--import", extension, bin, "service", ...args, "--space", space, "--json"], {
      cwd: root, env, timeout: 120_000,
    }).then(r => ({ ...r, status: 0 }), (error: { code: unknown; stdout?: string; stderr?: string }) => {
      if (typeof error.code !== "number" || !error.stdout) throw error;
      return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    });
    return { status: result.status, receipt: JSON.parse(result.stdout) };
  };
  for (const [name, allowedTools] of [["managed-restricted", ["read_issue"]], ["managed-malformed", [42]]] as const) {
    writeFileSync(join(linearDir(), `${name}.json`), JSON.stringify({ name, mode: "write", auth: "token", tokenFile, allowedTools }), { mode: 0o600 });
    const added = await service("add", name, "--preset", "linear", "--root", root, "--account", name, "--endpoint", managedEndpoint);
    if (added.status !== 0) throw new Error(`service fixture could not save ${name}: ${JSON.stringify(added.receipt.error)}`);
  }
  const beforeStart = managedRequests;
  const malformed = await service("start", "managed-malformed");
  const refusedBeforeLaunch = malformed.status === 2 && malformed.receipt.error?.code === "DEPENDENCY_UNAVAILABLE"
    && malformed.receipt.error.remedy?.includes("`allowedTools`") === true && malformed.receipt.target?.pid === null && managedRequests === beforeStart;
  check("managed start refuses malformed allowedTools before launching or contacting Linear", refusedBeforeLaunch);
  if (!refusedBeforeLaunch) console.error(JSON.stringify({ ...malformed, managedRequests: managedRequests - beforeStart }));
  if (malformed.receipt.target?.pid || malformed.receipt.result?.pid) {
    await service("stop", "managed-malformed", "--yes");
  }
  let managedCaller: CotalEndpoint | undefined;
  try {
    const started = await service("start", "managed-restricted");
    if (started.status !== 0) throw new Error(`restricted service did not start: ${JSON.stringify(started.receipt.error)}`);
    const minted = await provisionLinearCaller(auth, { servers, space, tls: false }, managedEndpoint);
    managedCaller = new CotalEndpoint({ space, servers, tls: false, creds: minted.creds, lifecycleUid: minted.lifecycleUid, consume: false,
      registerPresence: false, watchPresence: false, watchChannels: false, channels: [], card: { name: "managed-policy-caller", kind: "agent" } });
    managedCaller.on("error", () => {});
    await managedCaller.start();
    const { reply } = await managedCaller.invokeService(managedEndpoint, "inventory", {}, { deadlineMs: 5000 });
    if (!reply.ok) throw new Error(`managed inventory failed: ${reply.error.message}`);
    const inventoryDigest = (reply.data as { digest: string }).digest;
    const beforeCalls = calls.length;
    const allowed = await managedCaller.invokeService(managedEndpoint, "call-tool", { name: "read_issue", inventoryDigest }, { deadlineMs: 5000 });
    const denied = await managedCaller.invokeService(managedEndpoint, "call-tool", { name: "delete_issue", inventoryDigest }, { deadlineMs: 5000 });
    check("managed Linear service lets only the allowed tool reach the upstream", allowed.reply.ok && calls.slice(beforeCalls).join(",") === "read_issue"
      && !denied.reply.ok && denied.reply.error.code === "permission-denied" && denied.reply.error.outcome === "not-executed");
  } finally {
    try { await managedCaller?.stop(); }
    finally {
      const stopped = await service("stop", "managed-restricted", "--yes");
      check("managed Linear test service stops", stopped.status === 0 && stopped.receipt.result?.originalIncarnationGone === true);
    }
  }
}

async function login(name: string, noise: boolean, invalidRecord: "before" | "pending" | undefined = undefined): Promise<void> {
  const log = console.log;
  let authorize!: (url: URL) => void;
  const ready = new Promise<URL>(resolve => { authorize = resolve; });
  console.log = (...values: unknown[]) => {
    const match = /https:\/\/mcp\.linear\.app\/authorize\?\S+/.exec(values.map(String).join(" "));
    if (match) authorize(new URL(match[0]));
  };
  let settled = false;
  let loginError: unknown;
  const beforeTokens = tokenExchanges;
  const statePath = oauthStatePath(name);
  const accountPath = join(linearDir(), `${name}.json`);
  const beforeState = existsSync(statePath) ? readFileSync(statePath, "utf8") : undefined;
  const done = linear({ raw: [], positionals: ["account", "login", name], values: { mode: "write", plain: true } })
    .then(() => { settled = true; return true; }, error => { loginError = error; settled = true; return false; });
  const loginRefusal = () => {
    console.log = log;
    check("invalid account login refuses before token exchange", tokenExchanges === beforeTokens);
    check("invalid account login leaves OAuth state untouched", (existsSync(statePath) ? readFileSync(statePath, "utf8") : undefined) === beforeState);
    check("invalid account login names record, policy and remedy", repairNamed(loginError, accountPath));
    console.log(`  OBSERVED login ${name}: token exchanges=${tokenExchanges - beforeTokens}, result=${(loginError as { code?: string })?.code ?? "saved"}`);
  };
  try {
    if (invalidRecord === "before") {
      const outcome = await Promise.race([ready.then(() => "authorize"), done.then(() => "refused")]);
      if (outcome === "refused") {
        loginRefusal();
        return;
      }
    }
    const url = await Promise.race([ready, done.then(() => { throw new Error("login ended before authorization"); })]);
    console.log = log;
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    const valid = new URL(redirect);
    valid.searchParams.set("state", url.searchParams.get("state")!);
    valid.searchParams.set("code", "local-code");
    if (invalidRecord === "pending") writeFileSync(accountPath, "{");
    if (noise) {
      const beforeTokens = tokenExchanges;
      for (const state of ["not-the-login-state", undefined]) {
        const bad = new URL(redirect);
        if (state !== undefined) bad.searchParams.set("state", state);
        bad.searchParams.set("code", "local-code");
        let status = 0;
        let body = "";
        try { const response = await nativeFetch(bad); status = response.status; body = await response.text(); } catch { /* listener closure is checked below */ }
        check(state === undefined ? "missing state code callback gets HTTP 400 after wrong-state callback" : "preexisting control: wrong-state code callback gets HTTP 400", status === 400);
        check("bad callback points to the pending authorization URL", body.includes("Return to the authorization URL printed by that login"));
        console.log(`  OBSERVED callback ${state === undefined ? "missing state" : "wrong state"}: HTTP ${status || "unavailable"}, settled=${settled}`);
      }
      await wait(40);
      check("bad OAuth state leaves login pending", !settled);
      check("preexisting control: bad OAuth state with code exchanges no token", tokenExchanges === beforeTokens);
    }
    if (noise && settled) {
      await done;
      check("valid OAuth callback succeeds after bad state", false);
      check("OAuth account saved after bad state", false);
      check("OAuth login preserves existing tool policy", false);
      return;
    }
    let status = 0;
    try { const response = await nativeFetch(valid); status = response.status; await response.text(); } catch { /* a stopped callback server is the observed failure */ }
    const saved = await done;
    if (invalidRecord) {
      loginRefusal();
      if (invalidRecord === "pending") {
        check("a matching callback against a damaged account is answered with HTTP 400", status === 400);
        check("the refused callback does not replace the damaged record", readFileSync(accountPath, "utf8") === "{");
      }
      return;
    }
    check(noise ? "valid OAuth callback succeeds after bad state" : "preexisting control: valid OAuth callback succeeds", status === 200 && saved);
    if (saved) {
      check(noise ? "OAuth account saved after bad state" : "preexisting control: OAuth account saved", loadAccount(name).auth === "oauth");
      if (noise) check("OAuth login preserves existing tool policy", loadAccount(name).allowedTools?.join(",") === "read_issue");
    }
  } finally { console.log = log; await done; }
}

try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { ready = await isReachable(servers); if (!ready) await wait(20); }
  if (!ready) throw new Error("owned broker failed to start");
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  // Record through the existing account operation, then edit its existing JSON config surface.
  const log = console.log;
  try { console.log = () => {}; await linear({ raw: [], positionals: ["account", "add", "limited"], values: { mode: "write", "token-file": tokenFile, plain: true } }); }
  finally { console.log = log; }
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), allowedTools: ["read_issue"] }), { mode: 0o600 });
  const restricted = new LinearUpstream(loadAccount("limited"));
  check("account loader retains configured tool names", loadAccount("limited").allowedTools?.join(",") === "read_issue");
  saveAccount({ name: "limited", mode: "write", auth: "token", tokenFile });
  check("credential replacement preserves existing tool policy", loadAccount("limited").allowedTools?.join(",") === "read_issue");
  upstreams.push(restricted);
  const inv = await restricted.inventory();
  check("preexisting control: inventory remains complete under a tool allowlist", inv.tools.length === 2);
  registration = await registerLinearEndpoint({ auth, servers, space, tls: false, endpoint });
  running = await runLinearEndpoint(registration.bundle, restricted);
  const minted = await provisionLinearCaller(auth, { servers, space, tls: false }, endpoint);
  caller = new CotalEndpoint({ space, servers, tls: false, creds: minted.creds, lifecycleUid: minted.lifecycleUid, consume: false,
    registerPresence: false, watchPresence: false, watchChannels: false, channels: [], card: { name: "policy-caller", kind: "agent" } });
  caller.on("error", () => {});
  await caller.start();
  const invoke = (name: string) => caller!.invokeService(endpoint, "call-tool", { name, inventoryDigest: inv.digest }, { deadlineMs: 5000 });
  const positive = await invoke("read_issue");
  check("preexisting control: allowed tool executes through registered endpoint", positive.reply.ok && calls.includes("read_issue"));
  const before = calls.length;
  const denied = await invoke("delete_issue");
  console.log(`  OBSERVED endpoint call with tool omitted: ${denied.reply.error?.code ?? "result"}, upstream calls=${calls.length - before}`);
  check("unlisted tool returns permission-denied not-executed", !denied.reply.ok && denied.reply.error?.code === "permission-denied" && denied.reply.error.outcome === "not-executed");
  check("unlisted tool never reaches upstream HTTP", calls.length === before);
  check("endpoint refusal names the edit and restart", denied.reply.error?.message.includes("add its name to `allowedTools`") === true && denied.reply.error.message.includes("restart the Linear service"));
  const unrestricted = new LinearUpstream({ name: "default", mode: "write", auth: "token", tokenFile });
  upstreams.push(unrestricted);
  const ordinary = await unrestricted.callTool({ name: "delete_issue" });
  check("preexisting control: omitted allowlist retains upstream access", ordinary.kind === "result");
  const originalRecord = readFileSync(record, "utf8");
  for (const invalid of [null, "read_issue", [""], [" read_issue"], ["read_issue", "read_issue"], [42], ["read\nissue"], ["read\u0001issue"], ["read\u009bissue"]]) {
    writeFileSync(record, JSON.stringify({ ...JSON.parse(originalRecord), allowedTools: invalid }));
    let error: unknown;
    try { await linear({ raw: [], positionals: ["account", "show", "limited"], values: { json: true } }); } catch (caught) { error = caught; }
    console.log(`  OBSERVED account show with ${JSON.stringify(invalid)}: ${(error as { code?: string } | undefined)?.code ?? "result"}`);
    check("malformed allowedTools configuration refuses with repair", repairNamed(error, record));
    writeFileSync(record, originalRecord);
    check("repairing malformed allowedTools restores the record", loadAccount("limited").allowedTools?.[0] === "read_issue");
  }
  const oauthBlocked = new LinearUpstream({ name: "absent-oauth", mode: "write", auth: "oauth", allowedTools: [] });
  upstreams.push(oauthBlocked);
  const beforeOAuth = tokenExchanges;
  const oauthDenied = await oauthBlocked.callTool({ name: "read_issue" });
  check("OAuth tool refusal precedes missing credential read and exchange", oauthDenied.kind === "refused" && oauthDenied.reason === "tool-not-allowed" && tokenExchanges === beforeOAuth && !existsSync(oauthStatePath("absent-oauth")));
  let report = "";
  const stdout = process.stdout.write.bind(process.stdout);
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => { report += String(chunk); return true; }) as typeof process.stdout.write;
    await linear({ raw: [], positionals: ["account", "show", "limited"], values: { json: true } });
  } finally { process.stdout.write = stdout; }
  check("account show reports configured allowlist", JSON.parse(report).result.allowedTools?.[0] === "read_issue");
  for (const [names, tool] of [[[], "read_issue"], [["READ_ISSUE"], "read_issue"], [["read_*"], "read_issue"], [["read_issue"], "delete_issue"]] as const) {
    report = "";
    let cliCode: number | undefined;
    writeFileSync(record, JSON.stringify({ ...JSON.parse(originalRecord), allowedTools: names }), { mode: 0o600 });
    const before = calls.length;
    try {
      process.stdout.write = ((chunk: string | Uint8Array) => { report += String(chunk); return true; }) as typeof process.stdout.write;
      await linear({ raw: [], positionals: ["call", "limited", tool], values: { json: true } });
      cliCode = process.exitCode as number | undefined;
    } finally { process.stdout.write = stdout; process.exitCode = undefined; }
    const refusal = JSON.parse(report);
    console.log(`  OBSERVED linear call limited ${tool} --json with ${JSON.stringify(names)}: exit ${cliCode ?? 0}, ${refusal.error?.code ?? "result"}, upstream calls=${calls.length - before}`);
    check("direct CLI refuses disallowed tool with exit 2 and the edit remedy", cliCode === 2 && refusal.result.reply.reason === "tool-not-allowed" && refusal.result.reply.detail.includes("add its name to `allowedTools`"));
    check("direct CLI includes the edit in the structured failure remedy", refusal.error?.remedy?.includes("add the tool name to `allowedTools`") === true);
    check("direct CLI reports PERMISSION_DENIED and no execution", refusal.error?.code === "PERMISSION_DENIED" && refusal.result.reply.outcome === "not-executed" && calls.length === before);
  }
  writeFileSync(record, JSON.stringify({ ...JSON.parse(originalRecord), allowedTools: ["read_issue", "delete_issue"] }), { mode: 0o600 });
  report = "";
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => { report += String(chunk); return true; }) as typeof process.stdout.write;
    await linear({ raw: [], positionals: ["call", "limited", "delete_issue"], values: { json: true } });
  } finally { process.stdout.write = stdout; process.exitCode = undefined; }
  check("direct CLI calls the tool after the operator adds it to the list", JSON.parse(report).result.reply.kind === "result");
  await running.stop();
  const restarted = new LinearUpstream(loadAccount("limited"));
  upstreams.push(restarted);
  running = await runLinearEndpoint(registration.bundle, restarted);
  await waitForRestartedEndpoint(caller);
  check("endpoint calls the tool after editing and restarting the service", (await invoke("delete_issue")).reply.ok);
  for (const [name, contents] of [["invalid-readd", JSON.stringify({ name: "invalid-readd", mode: "write", auth: "oauth", allowedTools: [42] })], ["corrupt-readd", "{"]] as const) {
    const path = join(linearDir(), `${name}.json`);
    writeFileSync(path, contents);
    let addError: unknown;
    try { await linear({ raw: [], positionals: ["account", "add", name], values: { mode: "write", "token-file": tokenFile, plain: true } }); } catch (error) { addError = error; }
    check("re-add over invalid record refuses with path, reason and remedy", repairNamed(addError, path) && /allowedTools|JSON/i.test(String(addError)));
    check("refused re-add preserves invalid policy bytes", readFileSync(path, "utf8") === contents);
    writeFileSync(path, contents);
    const tokenBeforeSave = readFileSync(tokenFile, "utf8");
    let saveError: unknown;
    try { saveAccount({ name, mode: "write", auth: "token", tokenFile }, "replacement-token"); } catch (error) { saveError = error; }
    check("saveAccount refuses invalid existing record before credential write", repairNamed(saveError, path) && readFileSync(tokenFile, "utf8") === tokenBeforeSave);
    check("refused direct save preserves invalid record bytes", readFileSync(path, "utf8") === contents);
    console.log(`  OBSERVED re-add ${name}: error=${(addError as { code?: string })?.code ?? "none"}, preserves record=${readFileSync(path, "utf8") === contents}`);
    repairAccount(name);
    await linear({ raw: [], positionals: ["account", "add", name], values: { mode: "write", "token-file": tokenFile, plain: true } });
    check("repairing the named record allows account add with the intended list", loadAccount(name).auth === "token" && loadAccount(name).allowedTools?.[0] === "read_issue");
  }
  if (process.platform !== "win32") {
    const name = "dangling-record";
    const path = join(linearDir(), `${name}.json`);
    const target = join(home, "missing-account.json");
    symlinkSync(target, path);
    const showError = await linear({ raw: [], positionals: ["account", "show", name], values: { json: true } }).then(() => undefined, (error: unknown) => error);
    check("a dangling account record read names the repair rather than suggesting a new account",
      (showError as { code?: string } | undefined)?.code === "DEPENDENCY_UNAVAILABLE" && repairNamed(showError, path));
    const add = () => linear({ raw: [], positionals: ["account", "add", name], values: { mode: "write", "token-file": tokenFile, plain: true } });
    const error = await add().then(() => undefined, (error: unknown) => error);
    const preserved = lstatSync(path).isSymbolicLink() && !existsSync(target);
    console.log(`  OBSERVED re-add ${name}: error=${(error as { code?: string } | undefined)?.code ?? "none"}, preserves record=${preserved}`);
    check("a dangling account record refuses replacement and names the repair", repairNamed(error, path) && preserved);
    writeFileSync(target, JSON.stringify({ name, mode: "write", auth: "oauth", allowedTools: ["read_issue"] }), { mode: 0o600 });
    await add();
    check("restoring the linked account record allows replacement with its policy", loadAccount(name).auth === "token" && loadAccount(name).allowedTools?.[0] === "read_issue");
  }
  writeFileSync(join(linearDir(), "invalid-login.json"), JSON.stringify({ name: "invalid-login", mode: "write", auth: "oauth", allowedTools: [42] }));
  await login("invalid-login", false, "before");
  repairAccount("invalid-login");
  await login("invalid-login", false);
  writeFileSync(join(linearDir(), "corrupt-login.json"), "{");
  await login("corrupt-login", false, "before");
  repairAccount("corrupt-login");
  await login("corrupt-login", false);
  await login("clean-login", false);
  await login("clean-login", false, "pending");
  repairAccount("clean-login");
  await login("clean-login", false);
  saveAccount({ name: "noisy-login", mode: "write", auth: "oauth", allowedTools: ["read_issue"] });
  await login("noisy-login", true);
  await managedToolPolicy();
} finally {
  if (caller) await caller.stop();
  if (running) await running.stop();
  if (registration) await registration.deregister();
  for (const upstream of upstreams) await upstream.close();
  globalThis.fetch = nativeFetch;
  http.closeAllConnections();
  await new Promise<void>(resolve => http.close(() => resolve()));
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  rmSync(home, { recursive: true, force: true });
}
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
