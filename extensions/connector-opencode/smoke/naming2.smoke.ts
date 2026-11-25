/**
 * The OpenCode 2.x connector's naming request (SPEC 13.22): the calls it makes on the seat's server,
 * against a stand-in server that records them.
 *
 * Covered: it waits for the seat's session, creates a child session of it, asks `generate` with the
 * instruction and the message, returns the text, and deletes the child session, also when `generate`
 * fails; a seat with no session refuses before any call; an answer with no text rejects.
 *
 * Run: pnpm smoke:opencode-naming
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createSuite } from "@cotal-ai/smoke-kit";
import { nameRequest } from "../../connector-core/src/agent-naming.js";
import { opencode2Naming } from "../src/naming2.js";

const { check, finish } = createSuite();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error: error as Error }; }
}

interface Call { method: string; path: string; body: unknown }
let calls: Call[] = [];
let generate: (body: unknown) => { status: number; body: unknown } = () => ({ status: 200, body: { data: { text: "Checkout canary flake" } } });
const read = (req: IncomingMessage) => new Promise<string>((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s)); });
const server = createServer(async (req, res) => {
  const raw = await read(req);
  const body = raw ? JSON.parse(raw) : undefined;
  calls.push({ method: req.method!, path: req.url!, body });
  const reply = (status: number, b?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(b === undefined ? "" : JSON.stringify(b)); };
  if (req.method === "POST" && req.url === "/api/session") return reply(200, { data: { id: "ses_child" } });
  if (req.method === "POST" && req.url === "/api/session/ses_child/generate") { const g = generate(body); return reply(g.status, g.body); }
  if (req.method === "DELETE" && req.url === "/api/session/ses_child") { res.writeHead(204); return res.end(); }
  reply(404, { error: "no route" });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json" } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
};
const logs: string[] = [];
const TEXT = "look into the flaky checkout-service canary";
const ask = (session: () => Promise<string | undefined>) =>
  opencode2Naming({ api, session, log: (m) => logs.push(m) }).request({ ...nameRequest(TEXT), signal: new AbortController().signal });

try {
  console.log("a request that answers");
  {
    let release!: (id: string) => void;
    const sessionReady = new Promise<string>((r) => (release = r));
    const pending = ask(() => sessionReady);
    await new Promise((r) => setTimeout(r, 100));
    check("nothing is asked before the seat's session exists", calls.length === 0, calls);
    release("ses_seat");
    const answer = await pending;
    const { system, prompt } = nameRequest(TEXT);
    check("it resolves to generate's text", answer === "Checkout canary flake", answer);
    check("it creates a child session of the seat's, asks generate on it with the instruction and the message, then deletes it",
      same(calls.map((c) => `${c.method} ${c.path}`), ["POST /api/session", "POST /api/session/ses_child/generate", "DELETE /api/session/ses_child"]), calls);
    check("the child session names the seat's session as its parent", (calls[0]!.body as { parentID?: unknown }).parentID === "ses_seat", calls[0]!.body);
    check("generate gets the instruction and the message, and nothing else", same(calls[1]!.body, { prompt: `${system}\n\n${prompt}` }), calls[1]!.body);
  }

  console.log("\na request that fails");
  {
    calls = [];
    generate = () => ({ status: 500, body: { error: "provider down" } });
    const r1 = await settled(ask(async () => "ses_seat"));
    check("a failed generate rejects, and the child session is still deleted",
      !r1.ok && r1.error.message.includes("500") && calls.at(-1)?.method === "DELETE" && calls.at(-1)?.path === "/api/session/ses_child", { r1, calls });
    calls = [];
    generate = () => ({ status: 200, body: { data: {} } });
    const r2 = await settled(ask(async () => "ses_seat"));
    check("an answer with no text rejects, and the child session is deleted", !r2.ok && calls.at(-1)?.method === "DELETE", { r2, calls });
    calls = [];
    const r3 = await settled(ask(async () => undefined));
    check("a seat with no session refuses before any call", !r3.ok && calls.length === 0, { r3, calls });
  }
} catch (e) {
  check(`the suite threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  server.close();
}
finish();
