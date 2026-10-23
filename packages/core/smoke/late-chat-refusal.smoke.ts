/**
 * A broker refusal of a channel's live subscription reaches the endpoint's `error` event once.
 *
 * nats.js hands the refusal to the subscription's callback and then dispatches the same instance on
 * the connection status. The callback owns it: it leaves the channel and emits
 * `left channel "<ch>": ...` with the refusal as `cause`, so the status loop must not report it a
 * second time as a permission denial. A static user's subscribe denies are widened by a config
 * reload, which makes the broker revoke subscriptions it had already accepted.
 *
 * Run: pnpm smoke:late-chat-refusal
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionViolationError } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { CotalEndpoint, chatSubject, isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = "laterefusal";
const chat = (channel: string) => chatSubject(space, "*", "*", channel);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const confPath = join(dir, "server.conf");
const conf = (denied: string[]) => `listen: 127.0.0.1:${PORT}
jetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }
authorization {
  users: [
    { user: probe, password: probepw, permissions: { publish: ">", subscribe: { allow: ">", deny: ${JSON.stringify(denied.map(chat))} } } }
  ]
}
`;
writeFileSync(confPath, conf(["predenied", "bootdenied"]));
const srv = spawn("nats-server", ["-c", confPath], { stdio: ["ignore", "ignore", "pipe"] });
const releaseBroker = teardownOnSignal(srv, dir);
let brokerLog = "";
srv.stderr.on("data", (d) => { brokerLog += d; });

const raw: PermissionViolationError[] = [];
const events: Error[] = [];
const rawFor = (channel: string) => raw.filter((e) => e.subject === chat(channel));
const eventsFor = (channel: string) =>
  events.filter((e) => e.message.includes(`"${channel}"`) || e.message.includes(`"${chat(channel)}"`));
const leftMessage = (channel: string) => `left channel "${channel}": its live subscription was refused by the broker`;
const shown = (e: Error | undefined) => e && { message: e.message, cause: e.cause instanceof Error ? e.cause.message : e.cause };

let ep: CotalEndpoint | undefined;
try {
  await awaitBrokerReady(() => isReachable(SERVERS, { user: "probe", pass: "probepw" }), {
    servers: SERVERS, attempts: 50, delayMs: 100, output: () => brokerLog,
  });
  ep = new CotalEndpoint({
    space,
    servers: SERVERS,
    user: "probe",
    pass: "probepw",
    card: { name: "probe", kind: "agent" },
    channels: ["ok", "boot", "bootdenied"],
    onConnection: (nc) => {
      void (async () => {
        for await (const s of nc.status()) if (s.type === "error" && s.error instanceof PermissionViolationError) raw.push(s.error);
      })().catch(() => {});
    },
  });
  ep.on("error", (e) => events.push(e));
  await ep.start();
  await ep.joinChannel("lab");
  let predenied: unknown;
  try {
    await ep.joinChannel("predenied");
  } catch (e) {
    predenied = e;
  }
  await wait(750);

  console.log("1. a mid-session join the broker refuses is the join's own throw, never an error event");
  check("joinChannel(predenied) throws the read-ACL refusal",
    (predenied as Error | undefined)?.message === `cannot join "predenied": not within this agent's read ACL (allowSubscribe)`, predenied);
  check("the connection saw one refusal on the predenied subject", rawFor("predenied").length === 1, raw.map((e) => e.subject));
  check("no error event names predenied", eventsFor("predenied").length === 0, eventsFor("predenied").map((e) => e.message));

  console.log("2. a boot channel the broker refuses leaves once, carrying the refusal");
  const bootRefusal = rawFor("bootdenied");
  const bootEvents = eventsFor("bootdenied");
  check("the connection saw one refusal on the bootdenied subject", bootRefusal.length === 1, raw.map((e) => e.subject));
  check("exactly one error event names bootdenied", bootEvents.length === 1, bootEvents.map((e) => e.message));
  check("it is the left-channel error, and its cause is the broker's refusal",
    bootEvents[0]?.message === leftMessage("bootdenied") && bootEvents[0]?.cause === bootRefusal[0], shown(bootEvents[0]));
  check("bootdenied is not joined", !ep.joinedChannels().includes("bootdenied"), ep.joinedChannels());
  check("no error event names ok, boot or lab before the reload",
    ["ok", "boot", "lab"].every((ch) => eventsFor(ch).length === 0), events.map((e) => e.message));
  check("ok, boot and lab are joined before the reload",
    ["ok", "boot", "lab"].every((ch) => ep!.joinedChannels().includes(ch)), ep.joinedChannels());

  writeFileSync(confPath, conf(["predenied", "bootdenied", "lab", "boot"]));
  srv.kill("SIGHUP");
  for (let i = 0; i < 100; i++) {
    const joined = ep.joinedChannels();
    if (!joined.includes("lab") && !joined.includes("boot")) break;
    await wait(100);
  }
  await wait(750);

  console.log("3. a refusal of an already-joined channel's live subscription is reported once, with its cause");
  for (const ch of ["lab", "boot"]) {
    const refusal = rawFor(ch);
    const reported = eventsFor(ch);
    check(`the connection saw one refusal on the ${ch} subject`, refusal.length === 1, raw.map((e) => e.subject));
    check(`exactly one error event names ${ch}`, reported.length === 1, reported.map((e) => e.message));
    check(`it is the left-channel error, and its cause is the broker's refusal (${ch})`,
      reported[0]?.message === leftMessage(ch) && reported[0]?.cause === refusal[0], shown(reported[0]));
    check(`${ch} is no longer joined`, !ep.joinedChannels().includes(ch), ep.joinedChannels());
  }

  console.log("4. the reload revoked only the narrowed subscriptions");
  check("ok stays joined with no error event", ep.joinedChannels().includes("ok") && eventsFor("ok").length === 0, ep.joinedChannels());
  const removed = [...brokerLog.matchAll(/Removed sub "([^"]+)"/g)].map((m) => m[1]).sort();
  check("the broker removed exactly the lab and boot subscriptions", JSON.stringify(removed) === JSON.stringify([chat("boot"), chat("lab")].sort()), removed);
  check("every error event is accounted for by a refused channel", events.length === 3, events.map((e) => e.message));

  console.log(`\nLATE CHAT REFUSAL: ${pass}/${pass + fail}`);
} finally {
  await ep?.stop().catch(() => {});
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
process.exit(fail ? 1 : 0);
