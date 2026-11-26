/** Real auth listeners: concurrent first exchanges share a root credential, malformed bodies consume
 * their face's refusal budget, and unexpected handler failures stay server-side. */
import { ServerResponse } from "node:http";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { epAuthBucket, mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { Kvm } from "@nats-io/kv";
import { decodeJwt } from "jose";
import { grantActor, grantManagedActor, newActorToken, startAuthService, type AuthServiceHandle } from "../dist/index.js";
import { startHostedAuthFixture, type HostedAuthAccount } from "./_hosted-auth-fixture.js";

const fx = await startHostedAuthFixture("http-errors", 1);
let service: AuthServiceHandle | undefined;
let passed = 0, failed = 0;
const check = (name: string, condition: boolean) => {
  if (condition) passed++; else failed++;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

async function checkConcurrentFirstExchanges(a: HostedAuthAccount) {
  const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const actor = "worker";
  const lifecycleUid = mintLifecycleUid();
  const { actorToken, tokenHash } = newActorToken();
  const envelope = { owner, scope: [], allowSubscribe: [], allowPublish: [] };
  grantActor(a.stateDir, { ...envelope, actor: "cli" });
  grantManagedActor(a.stateDir, { ...envelope, actor, lifecycleUid, tokenHash, parent: `${owner}.cli`, custody: { kind: "foreground" } });

  const post = async (url: string) => {
    const response = await fetch(`${url}/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, actor, actorToken }), signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as { token?: string; error?: string };
    const root = body.token ? (decodeJwt(body.token).act as { credentialId?: string }).credentialId : undefined;
    return { status: response.status, root, error: body.error };
  };

  const open = Kvm.prototype.open;
  const creates: string[] = [];
  let hold!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { hold = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let firstStore: Awaited<ReturnType<Kvm["open"]>> | undefined;
  const restorePuts: (() => void)[] = [];
  Kvm.prototype.open = async function (name, ...args) {
    const kv = await open.call(this, name, ...args);
    if (name !== epAuthBucket(a.space)) return kv;
    const put = kv.put;
    restorePuts.push(() => { kv.put = put; });
    kv.put = async (key, value, options) => {
      if (options?.previousSeq === 0 && key.startsWith(`cred.${lifecycleUid}.`)) {
        creates.push(key);
        if (creates.length === 1) { firstStore = kv; hold(); await released; }
      }
      return put.call(kv, key, value, options);
    };
    return kv;
  };

  let first: ReturnType<typeof post> | undefined;
  try {
    const started = service = await startAuthService({
      context: { accountPublicKey: a.accountPublicKey, lifecycleUid: "http-errors" },
      space: a.space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir: a.stateDir,
      publicFace: { port: 0, trustedProxy: false },
    });
    Kvm.prototype.open = open;
    const url = started.publicUrl!;
    first = post(url);
    await Promise.race([held, first.then((reply) => { throw new Error(`first exchange did not reach its create: ${JSON.stringify(reply)}`); })]);
    const second = await post(url);
    release();
    const resumed = await first;
    const third = await post(url);
    console.log(`first exchange race: ${JSON.stringify({ second, resumed, third, creates: creates.length })}`);
    check("both first exchanges and a later exchange return the same stamped root", second.status === 200 && !!second.root &&
      resumed.status === 200 && resumed.root === second.root && third.status === 200 && third.root === second.root);
    check("only the first two exchanges stage rows", creates.length === 2 && creates[1] === `cred.${lifecycleUid}.${second.root}`);
    const losing = await firstStore?.get(creates[0]);
    check("the delayed exchange's unpublished row is revoked", losing?.operation === "PUT" &&
      (JSON.parse(new TextDecoder().decode(losing.value)) as { state: string }).state === "revoked");
  } finally {
    release();
    Kvm.prototype.open = open;
    await first?.catch(() => {});
    for (const restore of restorePuts) restore();
  }
}

const writeHead = ServerResponse.prototype.writeHead;
const log = console.error;
try {
  const a = fx.accounts[0];
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  await checkConcurrentFirstExchanges(a);
  if (!service) throw new Error("auth service did not start");
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
