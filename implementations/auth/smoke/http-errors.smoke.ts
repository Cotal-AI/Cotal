/** Real auth listeners: malformed exchange bodies consume their face's refusal budget;
 * unexpected handler failures stay server-side. No copied routes or live credentials. */
import { ServerResponse } from "node:http";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { mintCreds, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { startAuthService, type AuthServiceHandle } from "../dist/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const fx = await startHostedAuthFixture("http-errors", 1);
let service: AuthServiceHandle | undefined;
let passed = 0, failed = 0;
const check = (name: string, condition: boolean) => {
  if (condition) passed++; else failed++;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};
const writeHead = ServerResponse.prototype.writeHead;
const log = console.error;
try {
  const a = fx.accounts[0];
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  service = await startAuthService({
    context: { accountPublicKey: a.accountPublicKey, lifecycleUid: "http-errors" },
    space: a.space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir: a.stateDir,
    publicFace: { port: 0, trustedProxy: false },
  });
  for (const [face, url, headers] of [
    ["loopback", service.url, { authorization: `Bearer ${service.cap}` }],
    ["public", service.publicUrl!, {}],
  ] as const) {
    const post = async (body: string, extra: Record<string, string> = {}) => {
      const response = await fetch(`${url}/exchange`, { method: "POST", headers: { "content-type": "application/json", ...headers, ...extra }, body });
      return { status: response.status, body: await response.json() as { error?: string } };
    };
    check(`${face}: healthy listener`, (await fetch(`${url}/health`)).status === 200);
    check(`${face}: method refusal preserved`, (await fetch(`${url}/exchange`)).status === 405);
    check(`${face}: browser-origin refusal preserved`, (await post("null", { origin: "https://fixture.invalid" })).status === 403);
    const invalid = await post("{");
    check(`${face}: malformed JSON stays a named 400`, invalid.status === 400 && invalid.body.error === "request body is not valid JSON");
    const large = await post("x".repeat(65 * 1024));
    check(`${face}: size refusal stays 413`, large.status === 413 && large.body.error?.includes("request body too large") === true);
    for (const body of ["null", "[]", "true", "42", '"text"']) {
      const reply = await post(body);
      if (body === "null") console.log(`${face}: null response ${JSON.stringify(reply)}`);
      check(`${face}: ${body} gets the shape refusal`, reply.status === 400 && reply.body.error === "exchange body must be a JSON object");
    }
    const statuses: number[] = [];
    for (let i = 5; i < 30; i++) statuses.push((await post("null")).status);
    check(`${face}: first 30 malformed objects use the normal refusal`, statuses.length === 25 && statuses.every(s => s === 400));
    const limited = await post("null");
    check(`${face}: malformed objects consume the refusal budget`, limited.status === 429 && limited.body.error === "too many refused exchanges - wait a minute and retry");
    check(`${face}: health stays available with a full refusal budget`, (await fetch(`${url}/health`)).status === 200);

    for (const fault of [new Error("synthetic private handler detail"), "synthetic private thrown value"]) {
      const logs: unknown[][] = [];
      console.error = (...args: unknown[]) => { logs.push(args); };
      // Fail the real response dependency once, before it sends headers. The actual route and
      // dispatcher handle the error; the next write is the dispatcher's error response.
      let injected = false;
      ServerResponse.prototype.writeHead = function () {
        ServerResponse.prototype.writeHead = writeHead;
        injected = true;
        throw fault;
      };
      let response: Response;
      try { response = await fetch(`${url}/health`); }
      finally { ServerResponse.prototype.writeHead = writeHead; console.error = log; }
      const body = await response.json();
      console.log(`${face}: injected failure response ${JSON.stringify({ status: response.status, body })}`);
      check(`${face}: real handler dependency fault reached`, injected);
      check(`${face}: unexpected failure is a generic 500`, response.status === 500 && JSON.stringify(body) === JSON.stringify({ error: "internal server error" }));
      check(`${face}: unexpected detail is logged server-side`, logs.some(args => args[0] === "auth-service: unexpected request error" && args[1] === fault));
      check(`${face}: listener recovers after handler failure`, (await fetch(`${url}/health`)).status === 200);
    }
  }
  check("loopback: capability gate remains separate", (await fetch(`${service.url}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" })).status === 401);
} finally {
  ServerResponse.prototype.writeHead = writeHead;
  console.error = log;
  try { await service?.close(); } finally { await fx.close(); }
}
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
