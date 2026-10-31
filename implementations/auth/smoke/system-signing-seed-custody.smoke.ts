/** Owned fixture for the system-account signing seed custody behind own-broker caller issuance.
 *  In-memory store, real trust records from `createSpaceAuth` and `rotateSystemAccount`, and the real
 *  observer minter. Cells: a fresh root retains the seed beside a seed-free trust record; the daemon
 *  composition mints fresh 60 s VARZ-only credentials from it and survives a restart over the same
 *  store; a root without the record composes nothing and says why; a stale, foreign or malformed
 *  record refuses; an explicit rotation replaces the record with the successor's. No broker. */
import { createSpaceAuth, credsClaims, rotateSystemAccount } from "@cotal-ai/core";
import { getSpaceAuth, putSpaceAuth, readSystemSigningSeed, retainSystemSigningSeed, systemSigningSeedKey } from "@cotal-ai/workspace";
import { CALLER_PAYLOAD_NOT_COMPOSED, ownBrokerCallerPayload, serviceEndpointsOption } from "../src/own-broker-caller-payload.js";
import { checks } from "./_service-custody-fixture.js";
import { MemoryStore } from "./_hosted-auth-fixture.js";

const c = checks();
const space = "sysseed-fx";
const thrown = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } };

const store = new MemoryStore({ kind: "injected", coordinate: "sysseed-fx" });
const auth = await createSpaceAuth(space);
await putSpaceAuth(store, auth);
await retainSystemSigningSeed(store, auth);
const record = await readSystemSigningSeed(store, space);
const persisted = await getSpaceAuth(store, space);
const outside = [...store.values.entries()].filter(([k]) => k !== systemSigningSeedKey(space)).map(([, v]) => v).join("\n");
c.check("S1 a fresh root retains the seed under its own key, naming the system account", record?.sysPub === auth.sys.pub && record?.signingSeed === auth.sys.signingSeed, record?.sysPub);
c.check("S1 the trust record stays seed-free and no other record carries the seed", persisted?.sys.signingSeed === undefined && !outside.includes(auth.sys.signingSeed!));

const composed = await ownBrokerCallerPayload(store, space);
c.check("S2 the daemon composition is composed from the retained seed", composed.state === "composed" && composed.sysPub === auth.sys.pub, composed);
if (composed.state === "composed") {
  const first = await composed.callerPayload.observerCreds(), second = await composed.callerPayload.observerCreds();
  const a = credsClaims(first), b = credsClaims(second), now = Math.floor(Date.now() / 1000);
  c.check("S2 each bootstrap mints a fresh credential signed by that system account, VARZ-only, at most 60 s",
    a.iss === auth.sys.pub && b.iss === auth.sys.pub && a.sub !== b.sub && JSON.stringify(a.nats?.pub?.allow) === JSON.stringify(["$SYS.REQ.SERVER.*.VARZ"])
    && (a.exp ?? 0) > now && (a.exp ?? 0) <= now + 60, { iss: a.iss, allow: a.nats?.pub?.allow, exp: (a.exp ?? 0) - now });
  c.check("S2 the credential carries no seed", !first.includes(auth.sys.signingSeed!));
}
const again = await ownBrokerCallerPayload(store, space);
c.check("S3 a restart over the same store composes again, outside any creation window", again.state === "composed" && again.sysPub === auth.sys.pub);

const bare = new MemoryStore({ kind: "injected", coordinate: "bare" });
await putSpaceAuth(bare, auth);
const absent = await ownBrokerCallerPayload(bare, space), empty = await ownBrokerCallerPayload(new MemoryStore({ kind: "injected", coordinate: "empty" }), space);
c.check("S4 a root with the trust record and no retained seed composes nothing and says why", absent.state === "absent" && absent.reason === CALLER_PAYLOAD_NOT_COMPOSED, absent);
c.check("S4 a store with no trust record composes nothing", empty.state === "absent" && empty.reason === CALLER_PAYLOAD_NOT_COMPOSED);

const other = await createSpaceAuth("other-fx");
const stale = new MemoryStore({ kind: "injected", coordinate: "stale" });
await putSpaceAuth(stale, auth);
await stale.put(systemSigningSeedKey(space), JSON.stringify({ v: 1, kind: "system-signing-seed", sysPub: other.sys.pub, signingSeed: other.sys.signingSeed }));
const foreign = await thrown(() => ownBrokerCallerPayload(stale, space));
await stale.put(systemSigningSeedKey(space), JSON.stringify({ v: 1, kind: "system-signing-seed", sysPub: auth.sys.pub, signingSeed: other.sys.signingSeed }));
const underived = await thrown(() => ownBrokerCallerPayload(stale, space));
await stale.put(systemSigningSeedKey(space), "{not json");
const malformed = await thrown(() => ownBrokerCallerPayload(stale, space));
c.check("S5 a record for another system account refuses the start, naming both accounts", /names account/.test(foreign) && foreign.includes(other.sys.pub) && foreign.includes(auth.sys.pub), foreign);
c.check("S5 a seed that does not derive its recorded account refuses", /does not derive/.test(underived), underived);
c.check("S5 a malformed record refuses rather than reading around it, and carries no seed", /not well formed/.test(malformed) && !malformed.includes(auth.sys.signingSeed!), malformed);
c.check("S5 none of the refusals leaked a seed", ![foreign, underived, malformed].some((t) => t.includes(auth.sys.signingSeed!) || t.includes(other.sys.signingSeed!)));

const rotated = await rotateSystemAccount(auth);
await putSpaceAuth(store, rotated);
await retainSystemSigningSeed(store, rotated);
const after = await readSystemSigningSeed(store, space), composedAfter = await ownBrokerCallerPayload(store, space);
c.check("S6 an explicit rotation replaces the record with the successor's seed and account", after?.sysPub === rotated.sys.pub && after?.sysPub !== auth.sys.pub && after?.signingSeed === rotated.sys.signingSeed, after?.sysPub);
c.check("S6 the composition follows the successor; the retired account's seed is gone from custody", composedAfter.state === "composed" && composedAfter.sysPub === rotated.sys.pub && !JSON.stringify([...store.values.values()]).includes(auth.sys.signingSeed!));
const stripped = await thrown(() => retainSystemSigningSeed(store, { ...rotated, sys: { pub: rotated.sys.pub, jwt: rotated.sys.jwt } }));
c.check("S7 retaining from a stripped signer refuses", /no system-account signing seed/.test(stripped), stripped);

// What the daemon passes to the plane: a legacy root (trust record, no custody) still opens the
// engine and door; only caller issuance is left out, and the log says why.
const legacy = await serviceEndpointsOption(bare, space, true);
c.check("S8 a legacy root with --service-endpoints still opens the engine and door: startup normal, no callerPayload, and the reason logged",
  legacy.option?.startup.kind === "normal" && legacy.option.callerPayload === undefined && legacy.log === CALLER_PAYLOAD_NOT_COMPOSED, legacy);
const retainedOpt = await serviceEndpointsOption(store, space, true);
c.check("S8 a root with custody passes the composed callerPayload and logs the account", retainedOpt.option?.callerPayload !== undefined && retainedOpt.log?.includes(rotated.sys.pub) === true, retainedOpt.log);
const untouched = new MemoryStore({ kind: "injected", coordinate: "untouched" });
untouched.get = async () => { throw new Error("the store must not be read with the flag off"); };
const off = await serviceEndpointsOption(untouched, space, false);
c.check("S8 without the flag nothing is composed and the store is not read", off.option === undefined && off.log === undefined);
const staleOpt = await thrown(() => serviceEndpointsOption(stale, space, true));
c.check("S8 a present but malformed record refuses the start rather than starting without issuance", /not well formed/.test(staleOpt), staleOpt);

console.log(c.failed === 0 ? `\nSYSTEM SIGNING SEED CUSTODY SMOKE OK (${c.passed} passed)` : `\nSYSTEM SIGNING SEED CUSTODY SMOKE FAILED (${c.passed} passed, ${c.failed} failed)`);
c.finish();
if (c.failed > 0) process.exit(1);
