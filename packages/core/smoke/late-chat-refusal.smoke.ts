/**
 * A channel subscription the broker refuses after its join was confirmed reaches the endpoint's
 * `error` event once: as `left channel "<channel>"`, with the refusal the connection dispatched as its
 * `cause`, and not again as a generic `NATS permission denied`. A static user's subscribe permissions
 * are narrowed by a config reload, which refuses a runtime-joined channel and a boot channel late.
 * A join outside the ACL from the start still throws with no error event, and a channel the reload
 * keeps stays joined with none.
 *
 * Run: pnpm smoke:late-chat-refusal   (needs `nats-server` on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionViolationError } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { CotalEndpoint, isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { check, finish } = createSuite();

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = "latechatrefusal";
const chat = (channel: string) => `cotal.${space}.chat.*.*.${channel}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const confPath = join(dir, "server.conf");
const conf = (denied: string[]) =>
  `listen: 127.0.0.1:${PORT}\njetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }\n` +
  `authorization { users: [ { user: probe, password: probepw, permissions: ` +
  `{ publish: ">", subscribe: { allow: ">", deny: ${JSON.stringify(denied)} } } } ] }\n`;
writeFileSync(confPath, conf([chat("predenied")]));
const srv = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const refusals: PermissionViolationError[] = [];
const errors: Error[] = [];
const ep = new CotalEndpoint({
  space, servers: SERVERS, user: "probe", pass: "probepw", card: { name: "probe", kind: "agent" }, channels: ["ok", "boot"],
  onConnection: (nc) => {
    void (async () => {
      for await (const s of nc.status())
        if (s.type === "error" && s.error instanceof PermissionViolationError) refusals.push(s.error);
    })();
  },
});
ep.on("error", (e: Error) => errors.push(e));
const errorsFor = (channel: string) =>
  errors.filter((e) => e.message.includes(`"${channel}"`) || (e.cause as { subject?: string } | undefined)?.subject === chat(channel));

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  await ep.start();
  await ep.joinChannel("lab");
  let predenied = "";
  await ep.joinChannel("predenied").catch((e: Error) => { predenied = e.message; });
  await wait(750);
  check("a join outside the ACL throws", predenied === `cannot join "predenied": not within this agent's read ACL (allowSubscribe)`, predenied);
  check("the join-time refusal reaches the connection once and the error event never",
    refusals.length === 1 && refusals[0]!.subject === chat("predenied") && errors.length === 0,
    { refusals: refusals.map((r) => r.subject), errors: errors.map((e) => e.message) });
  check("boot and runtime channels are joined before the reload", ep.joinedChannels().sort().join() === "boot,lab,ok", ep.joinedChannels());

  writeFileSync(confPath, conf([chat("predenied"), chat("lab"), chat("boot")]));
  srv.kill("SIGHUP");
  for (let i = 0; i < 100 && ep.joinedChannels().some((c) => c === "lab" || c === "boot"); i++) await wait(100);
  await wait(750);
  check("the reload drops lab and boot and keeps ok", ep.joinedChannels().join() === "ok", ep.joinedChannels());
  for (const channel of ["lab", "boot"]) {
    const refused = refusals.filter((r) => r.subject === chat(channel));
    const reported = errorsFor(channel);
    check(`${channel}: the broker refused the live subscription once`, refused.length === 1, refused.length);
    check(`${channel}: the late refusal reaches the error event once, as the channel leave carrying that refusal`,
      reported.length === 1
        && reported[0]!.message === `left channel "${channel}": its live subscription was refused by the broker`
        && reported[0]!.cause === refused[0],
      reported.map((e) => e.message));
  }
  check("the kept channel reports nothing", errorsFor("ok").length === 0, errorsFor("ok").map((e) => e.message));
  check("no other error is reported", errors.length === 2, errors.map((e) => e.message));
} catch (e) {
  check("late chat refusal scenario completed", false, (e as Error).stack ?? (e as Error).message);
} finally {
  await ep.stop().catch(() => {});
  await killAndAwaitExit(srv, "SIGKILL");
  releaseBroker();
  if (srv.exitCode === null && srv.signalCode === null) throw new Error("broker exit unproven; storage preserved");
  rmSync(dir, { recursive: true, force: true });
}

finish();
