// Proof harness for the provider REMOTE arm: stub IdP + stub capless exchange on loopback,
// sandboxed COTAL_HOME, real built dists. Positive mint + four negatives, byte counts printed.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SB = new URL("./sb/", import.meta.url).pathname;
mkdirSync(SB, { recursive: true });
const HOME = join(SB, "home"); mkdirSync(HOME, { recursive: true });
process.env.COTAL_HOME = HOME;

const ws = await import("../packages/workspace/dist/index.js");
const auth = await import("../implementations/auth/dist/provider.js");
const login = await import("../implementations/auth/dist/login.js");
const p = auth.cotalAuthProvider;
const store = ws.workspaceSecretStore ? ws.workspaceSecretStore(new URL("./sb/root", import.meta.url).pathname) : { get: async () => undefined };

let pass = 0, fail = 0;
const cell = (name, ok, extra) => { (ok ? ++pass : ++fail); console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " — " + String(extra)}`); };

// ---- stub server: /idp/token (needs the session bearer) + /ex/exchange (capless human arm)
const seen = { idpAuth: null, exAuth: "UNSET", exBody: null, exPath: null };
let exchangeMode = "ok";
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/idp/token") {
      seen.idpAuth = req.headers.authorization ?? null;
      if (seen.idpAuth !== "Bearer sess-xyz") { res.writeHead(401); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1MSJ9." }));
    }
    if (req.method === "POST" && req.url === "/ex/exchange") {
      seen.exAuth = req.headers.authorization ?? null;
      seen.exBody = JSON.parse(body);
      seen.exPath = req.url;
      if (exchangeMode === "refuse") {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "elevated views are a loopback operator surface" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "BEARER-OK-" + seen.exBody.actor }));
    }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;
const IDP = `http://127.0.0.1:${PORT}/idp`;
const EXBASE = `http://127.0.0.1:${PORT}/ex`;

// ---- registry entry + state dir + sentinel + session
const ROOT = join(SB, "root"); mkdirSync(join(ROOT, ".cotal"), { recursive: true });
const SPACE = "hackp";
const dir = ws.userAuthStateDir(ROOT, SPACE);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const sentinelPath = join(dir, "sentinel.creds");
writeFileSync(sentinelPath, "SENTINEL-DENY-ALL-BLOB", { mode: 0o600 });
ws.recordMesh({
  space: SPACE, server: "wss://broker.example.com:443/mesh-ws", root: ROOT, mode: "user",
  tlsRequired: true,
  userAuth: { provider: "cotal", idp: { url: IDP, issuer: "https://iss.example", audience: "https://iss.example" },
    endpoints: { url: EXBASE }, remote: true, sentinelCredsPath: sentinelPath },
  ts: new Date().toISOString(),
});
const key = login.normalizeIdpUrl(IDP);
writeFileSync(join(HOME, "idp-sessions.json"),
  JSON.stringify({ ver: 1, sessions: { [key]: { token: "sess-xyz", expiresAt: Date.now() + 3600_000, sub: "u1" } } }), { mode: 0o600 });

// ---- 1. positive mint
try {
  const out = await p.userCredentials({ store, dir, space: SPACE, actor: "cli" });
  cell("remote mint returns the exchange's bearer", out.bearer === "BEARER-OK-cli", out.bearer);
  cell("sentinelCreds are the registration-landed 0600 file bytes", out.sentinelCreds === "SENTINEL-DENY-ALL-BLOB", out.sentinelCreds?.slice(0, 30));
  cell("the exchange POST carried NO Authorization header (capless public face)", seen.exAuth === null, seen.exAuth);
  cell("the exchange body is the human arm {idpToken, actor} exactly", JSON.stringify(Object.keys(seen.exBody).sort()) === JSON.stringify(["actor", "idpToken"]) && seen.exBody.actor === "cli", JSON.stringify(seen.exBody));
  cell("the IdP /token round-trip presented the cached session bearer", seen.idpAuth === "Bearer sess-xyz", seen.idpAuth);
} catch (e) { cell("remote mint", false, e.message); fail += 4; }

// ---- 2. refusal surfaces the SERVER's words verbatim
exchangeMode = "refuse";
try { await p.userCredentials({ store, dir, space: SPACE, actor: "cli", view: "admin" }); cell("refused exchange throws", false, "no throw"); }
catch (e) { cell("a refused exchange surfaces the server's own copy", /elevated views are a loopback operator surface/.test(e.message), e.message); }
exchangeMode = "ok";

// ---- 3. no session -> the exact login line
writeFileSync(join(HOME, "idp-sessions.json"), JSON.stringify({ ver: 1, sessions: {} }), { mode: 0o600 });
try { await p.userCredentials({ store, dir, space: SPACE, actor: "cli" }); cell("no-session throws", false, "no throw"); }
catch (e) { cell("no login session names `cotal login --idp ...`", /cotal login --idp/.test(e.message), e.message); }
writeFileSync(join(HOME, "idp-sessions.json"),
  JSON.stringify({ ver: 1, sessions: { [key]: { token: "sess-xyz", expiresAt: Date.now() + 3600_000, sub: "u1" } } }), { mode: 0o600 });

// ---- 4. no registry entry -> names BOTH remedies
try { await p.userCredentials({ store, dir: join(SB, "nowhere"), space: "ghost", actor: "cli" }); cell("no-entry throws", false, "no throw"); }
catch (e) { cell("an unregistered space names `cotal meshes add --from` and `cotal up --user-auth`", /meshes add ghost --from/.test(e.message) && /up --user-auth/.test(e.message), e.message); }

// ---- 5. non-loopback http exchange pin -> refused before any network I/O
ws.recordMesh({
  space: "plaintext", server: "wss://x.example:443/ws", root: ROOT, mode: "user", tlsRequired: true,
  userAuth: { provider: "cotal", idp: { url: IDP, issuer: "i", audience: "a" },
    endpoints: { url: "http://203.0.113.7:8080" }, remote: true,
    sentinelCredsPath: join(ws.userAuthStateDir(ROOT, "plaintext"), "sentinel.creds") },
  ts: new Date().toISOString(),
});
const dir2 = ws.userAuthStateDir(ROOT, "plaintext"); mkdirSync(dir2, { recursive: true });
writeFileSync(join(dir2, "sentinel.creds"), "S", { mode: 0o600 });
try { await p.userCredentials({ store, dir: dir2, space: "plaintext", actor: "cli" }); cell("plaintext pin throws", false, "no throw"); }
catch (e) { cell("a non-loopback http exchange pin is refused as non-HTTPS", /non-HTTPS exchange/.test(e.message), e.message); }

// ---- 6. name-shaped loopback lookalike gets NO exception
ws.recordMesh({
  space: "lookalike", server: "wss://x.example:443/ws", root: ROOT, mode: "user", tlsRequired: true,
  userAuth: { provider: "cotal", idp: { url: IDP, issuer: "i", audience: "a" },
    endpoints: { url: "http://127.evil.example:8080" }, remote: true,
    sentinelCredsPath: join(ws.userAuthStateDir(ROOT, "lookalike"), "sentinel.creds") },
  ts: new Date().toISOString(),
});
const dir3 = ws.userAuthStateDir(ROOT, "lookalike"); mkdirSync(dir3, { recursive: true });
writeFileSync(join(dir3, "sentinel.creds"), "S", { mode: 0o600 });
try { await p.userCredentials({ store, dir: dir3, space: "lookalike", actor: "cli" }); cell("127.-name pin throws", false, "no throw"); }
catch (e) { cell("http://127.evil.example is a NAME and gets no loopback exception", /non-HTTPS exchange/.test(e.message), e.message); }

srv.close();
console.log(`\nremote-provider proof: ${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
