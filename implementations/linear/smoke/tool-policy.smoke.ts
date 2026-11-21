import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { LinearUpstream, loadAccount, registerLinearEndpoint, provisionLinearCaller, runLinearEndpoint } from "../src/index.js";
import { linear } from "../src/cli.js";
import { linearDir, oauthStatePath, saveAccount } from "../src/account.js";
import { LINEAR_MCP_ORIGIN } from "../src/origin.js";

const home = mkdtempSync(join(tmpdir(), "linear-policy-"));
process.env.COTAL_HOME = join(home, "cotal");
process.env.HOME = home;
let passed = 0, failed = 0;
function check(name: string, value: boolean): void {
  if (value) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}`); }
}
const calls: string[] = [];
let tokenExchanges = 0;
const http = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://local").pathname;
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

async function login(name: string, noise: boolean, invalidRecord = false): Promise<void> {
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
  const beforeState = existsSync(statePath) ? readFileSync(statePath, "utf8") : undefined;
  const done = linear({ raw: [], positionals: ["account", "login", name], values: { mode: "write", plain: true } })
    .then(() => { settled = true; return true; }, error => { loginError = error; settled = true; return false; });
  const loginRefusal = () => {
    console.log = log;
    check("invalid account login refuses before token exchange", tokenExchanges === beforeTokens);
    check("invalid account login leaves OAuth state untouched", (existsSync(statePath) ? readFileSync(statePath, "utf8") : undefined) === beforeState);
    check("invalid account login names record, policy and remedy", String(loginError).includes(`${name}.json`) && String(loginError).includes("allowedTools") && /repair|correct/i.test(String(loginError)));
  };
  try {
    if (invalidRecord) {
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
    if (noise) {
      const beforeTokens = tokenExchanges;
      for (const state of ["not-the-login-state", undefined]) {
        const bad = new URL(redirect);
        if (state !== undefined) bad.searchParams.set("state", state);
        bad.searchParams.set("code", "local-code");
        let status = 0;
        try { const response = await nativeFetch(bad); status = response.status; await response.text(); } catch { /* listener closure is checked below */ }
        check(state === undefined ? "missing state code callback gets HTTP 400 after wrong-state callback" : "preexisting control: wrong-state code callback gets HTTP 400", status === 400);
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
      console.log(`  OBSERVED invalid login: token exchanges=${tokenExchanges - beforeTokens}, state written=${existsSync(statePath)}, error=${(loginError as { code?: string })?.code ?? "none"}`);
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
  check("unlisted tool returns permission-denied not-executed", !denied.reply.ok && denied.reply.error?.code === "permission-denied" && denied.reply.error.outcome === "not-executed");
  check("unlisted tool never reaches upstream HTTP", calls.length === before);
  const unrestricted = new LinearUpstream({ name: "default", mode: "write", auth: "token", tokenFile });
  upstreams.push(unrestricted);
  const ordinary = await unrestricted.callTool({ name: "delete_issue" });
  check("preexisting control: omitted allowlist retains upstream access", ordinary.kind === "result");
  const originalRecord = readFileSync(record, "utf8");
  for (const invalid of [null, "read_issue", [""], [" read_issue"], ["read_issue", "read_issue"], [42], ["read\nissue"], ["read\u0001issue"]]) {
    writeFileSync(record, JSON.stringify({ ...JSON.parse(originalRecord), allowedTools: invalid }));
    let refused = false;
    try { loadAccount("limited"); } catch { refused = true; }
    check("malformed allowedTools configuration refuses", refused);
  }
  writeFileSync(record, originalRecord);
  for (const names of [[], ["READ_ISSUE"], ["read_*"]]) {
    const blocked = new LinearUpstream({ name: "empty", mode: "write", auth: "token", tokenFile: join(home, "absent.token"), allowedTools: names });
    upstreams.push(blocked);
    const result = await blocked.callTool({ name: "read_issue" });
    check("empty and nonmatching literal allowlists refuse before credential access", result.kind === "refused" && result.reason === "tool-not-allowed" && result.outcome === "not-executed");
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
  let cliCode: number | undefined;
  try {
    process.stdout.write = (() => true) as typeof process.stdout.write;
    await linear({ raw: [], positionals: ["call", "limited", "delete_issue"], values: { json: true } });
    cliCode = process.exitCode as number | undefined;
  } finally { process.stdout.write = stdout; process.exitCode = undefined; }
  check("direct CLI refuses disallowed tool with exit 2", cliCode === 2);
  for (const [name, contents] of [["invalid-readd", JSON.stringify({ name: "invalid-readd", mode: "write", auth: "oauth", allowedTools: [42] })], ["corrupt-readd", "{"]] as const) {
    const path = join(linearDir(), `${name}.json`);
    writeFileSync(path, contents);
    let addError: unknown;
    try { await linear({ raw: [], positionals: ["account", "add", name], values: { mode: "write", "token-file": tokenFile, plain: true } }); } catch (error) { addError = error; }
    check("re-add over invalid record refuses with path, reason and remedy", String(addError).includes(path) && /allowedTools|JSON/i.test(String(addError)) && /repair|correct/i.test(String(addError)));
    check("refused re-add preserves invalid policy bytes", readFileSync(path, "utf8") === contents);
    writeFileSync(path, contents);
    const tokenBeforeSave = readFileSync(tokenFile, "utf8");
    let saveError: unknown;
    try { saveAccount({ name, mode: "write", auth: "token", tokenFile }, "replacement-token"); } catch (error) { saveError = error; }
    check("saveAccount refuses invalid existing record before credential write", String(saveError).includes(path) && /repair/i.test(String(saveError)) && readFileSync(tokenFile, "utf8") === tokenBeforeSave);
    check("refused direct save preserves invalid record bytes", readFileSync(path, "utf8") === contents);
    console.log(`  OBSERVED re-add ${name}: error=${(addError as { code?: string })?.code ?? "none"}, preserves record=${readFileSync(path, "utf8") === contents}`);
  }
  writeFileSync(join(linearDir(), "invalid-login.json"), JSON.stringify({ name: "invalid-login", mode: "write", auth: "oauth", allowedTools: [42] }));
  await login("invalid-login", false, true);
  writeFileSync(join(linearDir(), "corrupt-login.json"), "{");
  await login("corrupt-login", false, true);
  await login("clean-login", false);
  saveAccount({ name: "noisy-login", mode: "write", auth: "oauth", allowedTools: ["read_issue"] });
  await login("noisy-login", true);
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
