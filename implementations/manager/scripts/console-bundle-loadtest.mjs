/**
 * FAIL-LOUD build gate (P2 item 6): load the console session bundle in a BROWSER-LIKE context —
 * `Buffer` and `process` deliberately ABSENT, only the globals a browser gives (crypto,
 * TextEncoder/Decoder, WebSocket, console). If the bundle references a node-ism at module load, or
 * its codec is not byte-exact standard base64, this THROWS and the build fails. Never a manual-only
 * check — this catches the next node-ism regression before it ships (the very class of bug that a
 * mere existence-check would have missed).
 */
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const BUNDLE = "dist/console/session-bundle.js";
const die = (msg) => { console.error(`FATAL: console bundle load-test — ${msg}`); process.exit(1); };

let code;
try { code = readFileSync(BUNDLE, "utf8"); } catch { die(`${BUNDLE} missing (esbuild did not produce it)`); }
if (!code || code.length === 0) die(`${BUNDLE} is empty`);

// A browser-like sandbox: NO Buffer, NO process. A stub WebSocket (wsconnect only touches it on
// connect, never at load). globalThis is the sandbox so the bundle's `globalThis.CotalSession = …`
// lands here.
const sandbox = { crypto: webcrypto, TextEncoder, TextDecoder, console, WebSocket: class {}, URL, setTimeout, clearTimeout, setInterval, clearInterval };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(code, sandbox, { filename: "session-bundle.js" });
} catch (e) {
  die(`the bundle THREW at load in a browser-like context (a node-ism regressed): ${e?.message ?? e}`);
}

const cs = sandbox.CotalSession;
if (!cs) die("the bundle did not define globalThis.CotalSession");
for (const fn of ["wsconnect", "credsAuthenticator", "openSessionRail", "encodeTerminalData", "decodeTerminalFrame", "terminalFrameBytes"]) {
  if (typeof cs[fn] !== "function") die(`CotalSession.${fn} is not a function (got ${typeof cs[fn]})`);
}

// Codec byte-exactness IN the browser-like context (no Buffer): the RFC 4648 "Man" vector + a
// full-byte-range roundtrip.
const enc = cs.encodeTerminalData(new TextEncoder().encode("Man"));
if (enc.b !== "TWFu") die(`base64 is not standard (encode "Man" → "${enc.b}", expected "TWFu")`);
const rt = cs.terminalFrameBytes(cs.decodeTerminalFrame(enc));
if (new TextDecoder().decode(rt) !== "Man") die("codec roundtrip corrupted the payload");
const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
const rtAll = cs.terminalFrameBytes(cs.encodeTerminalData(all));
if (rtAll.length !== 256 || [...rtAll].some((v, i) => v !== i)) die("full-byte-range codec roundtrip failed");

console.log("console session-bundle.js load-test OK (browser-like context, no Buffer/process; CotalSession complete; codec byte-exact)");
