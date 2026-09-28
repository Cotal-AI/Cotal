/** Two-account native fixture for the hosted auth lifetime smoke: one real broker, two data
 *  accounts, each with its own callout account and a fully provisioned in-memory injected store. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, serverConfig, type SecretStore } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { ensureCalloutAuth, ensureIssuer, ensureOwnerSecret, ensurePinnedIdp, saveServiceKeys } from "../src/store.js";
import { pickFreePort } from "./_free-port.js";

export class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async delete(k: string) { this.values.delete(k); }
}

export interface HostedAuthAccount {
  space: string;
  accountPublicKey: string;
  store: MemoryStore;
  stateDir: string;
  sentinelCreds: string;
}

export interface HostedAuthFixture {
  servers: string;
  dir: string;
  accounts: HostedAuthAccount[];
  close(): Promise<void>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startHostedAuthFixture(label: string, count = 2): Promise<HostedAuthFixture> {
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const broker = await createBrokerAuth(`${label}-broker`);
  const stamp = Date.now();
  const spaces = Array.from({ length: count }, (_, i) => `${label}-${String.fromCharCode(97 + i)}-${stamp}`);
  const spaceAccounts = await Promise.all(spaces.map((s) => createSpaceAccountAuth(broker, s)));
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const accounts: HostedAuthAccount[] = [];
  const calloutAccounts: Array<{ pub: string; jwt: string }> = [];
  for (const [i, space] of spaces.entries()) {
    const auth = composeSpaceAuth(broker, spaceAccounts[i]);
    const store = new MemoryStore({ kind: "injected", coordinate: `memory:${space}` });
    const callout = await ensureCalloutAuth(store, { space, operatorSeed: broker.operator.seed!, accountPub: auth.account.pub });
    await ensureIssuer(store, space);
    await ensureOwnerSecret(store, space);
    await saveServiceKeys(store, space, { dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! } });
    const stateDir = join(dir, `state-${i}`);
    mkdirSync(stateDir, { recursive: true });
    ensurePinnedIdp(stateDir, "http://127.0.0.1:1/api/auth");
    calloutAccounts.push({ pub: callout.account.pub, jwt: callout.account.jwt });
    accounts.push({ space, accountPublicKey: auth.account.pub, store, stateDir, sentinelCreds: callout.sentinelCreds });
  }
  writeFileSync(join(dir, "server.conf"), serverConfig(broker, spaceAccounts, { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"), extraAccounts: calloutAccounts }));
  const nats: ChildProcess = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  const release = teardownOnSignal(nats, dir);
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(200); }
  if (!up) { await killAndAwaitExit(nats, "SIGKILL"); release(); throw new Error(`nats-server did not come up on ${port}`); }
  return {
    servers, dir, accounts,
    async close() {
      await killAndAwaitExit(nats, "SIGKILL");
      nats.unref();
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      release();
    },
  };
}
