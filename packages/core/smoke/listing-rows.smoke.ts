/** Run after building core: pnpm smoke:listing-rows (no broker). What a listing generation adds to a
 *  legacy-rail credential, counted by direction and subject family, and what it does not reach. */
import { randomBytes } from "node:crypto";
import {
  acceptedReadGrant, epRequestSubject, issuedPermitsSubject, listingGrantRows, mintGeneration, mintLifecycleUid, permissionsFor,
  importNativeSubjectPermissions, BASELINE_LIFECYCLE_ENDPOINT, REGISTRY_ENDPOINT, REGISTRY_ENDPOINTS_COMMAND,
  type EpCaller, type IssuedCaller,
} from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";

const suite = createSuite();
const space = "rows";
const uid = mintLifecycleUid();
const principal = { owner: "u_alice", actor: "a1", connId: `ibx${randomBytes(16).toString("hex")}`, lifecycleUid: uid };
const listing = { generation: mintGeneration(Math.floor(Date.now() / 1000) + 3600), acceptedToken: randomBytes(16).toString("hex") };
const caller: EpCaller = { owner: principal.owner, actor: principal.actor, uid };
const listingCaller = { ...caller, generation: listing.generation } as IssuedCaller;
type Native = { pub: { allow: string[] }; sub: { allow: string[] } };
const delta = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
const v1 = `cotal.${space}.ep.v1.`;
const nonce = () => randomBytes(16).toString("base64url");

const cases: [string, "agent" | "manager-caller", { managerInstanceId?: string; capabilities?: string[] }][] = [
  ["agent", "agent", {}],
  ["manager-caller", "manager-caller", { managerInstanceId: mintLifecycleUid(), capabilities: ["spawn", "run"] }],
];
for (const [label, profile, extra] of cases) {
  const plain = permissionsFor(profile, space, principal, { ...extra }) as Native;
  const listed = permissionsFor(profile, space, principal, { ...extra, listing }) as Native;
  const pub = delta(plain.pub.allow, listed.pub.allow);
  const sub = delta(plain.sub.allow, listed.sub.allow);
  suite.check(`${label}: the publish delta is one ep.v1 request row and the accepted-row read`,
    pub.length === 2 && pub.filter((r) => r.startsWith(v1)).length === 1 && pub.includes(acceptedReadGrant(space, listing.acceptedToken))
      && pub.some((r) => r.startsWith(`${v1}one.${REGISTRY_ENDPOINT}.${REGISTRY_ENDPOINTS_COMMAND}.`)), pub);
  suite.check(`${label}: the subscribe delta is one ep.v1 reply row`, sub.length === 1 && sub[0]!.startsWith(v1), sub);
  suite.check(`${label}: the listing credential holds no other ep.v1 row`,
    listed.pub.allow.filter((r) => r.startsWith(v1)).length === 1 && plain.pub.allow.every((r) => !r.startsWith(v1)), listed.pub.allow.filter((r) => r.startsWith(v1)));
  const ceiling = importNativeSubjectPermissions(listed).publish;
  const v1Subject = (endpoint: string, command: string) => epRequestSubject(space, { route: { mode: "one" }, endpoint, command, caller: listingCaller, nonce: nonce() });
  suite.check(`${label}: the listing generation reaches the endpoints request`, issuedPermitsSubject(ceiling, v1Subject(REGISTRY_ENDPOINT, REGISTRY_ENDPOINTS_COMMAND)));
  suite.check(`${label}: the listing generation cannot publish run-start or an ordinary v1 describe`,
    !issuedPermitsSubject(ceiling, v1Subject(BASELINE_LIFECYCLE_ENDPOINT, "run-start")) && !issuedPermitsSubject(ceiling, v1Subject(BASELINE_LIFECYCLE_ENDPOINT, "describe")));
}

{
  const plain = permissionsFor("agent", space, principal, {}) as Native;
  const legacyDescribe = epRequestSubject(space, { route: { mode: "one" }, endpoint: REGISTRY_ENDPOINT, command: "describe", caller, nonce: nonce() });
  const listed = permissionsFor("agent", space, principal, { listing }) as Native;
  suite.check("the legacy describe of the registry is reachable with or without a listing generation",
    issuedPermitsSubject(importNativeSubjectPermissions(plain).publish, legacyDescribe) && issuedPermitsSubject(importNativeSubjectPermissions(listed).publish, legacyDescribe));
}

{
  const issued = { generation: mintGeneration(Math.floor(Date.now() / 1000) + 3600), acceptedToken: randomBytes(16).toString("hex") };
  const without = permissionsFor("agent", space, principal, { issued }) as Native;
  const withRow = permissionsFor("agent", space, principal, { issued: { ...issued, listing: true } }) as Native;
  const pub = delta(without.pub.allow, withRow.pub.allow);
  suite.check("an issuance that carries the listing adds the one endpoints row on its own generation",
    pub.length === 1 && pub[0]!.startsWith(`${v1}one.${REGISTRY_ENDPOINT}.${REGISTRY_ENDPOINTS_COMMAND}.`) && pub[0]!.includes(issued.generation), pub);
  suite.check("an issuance without the flag carries no endpoints row, so a pre-upgrade renewal mints the same ceiling",
    without.pub.allow.every((r) => !r.includes(`.${REGISTRY_ENDPOINT}.${REGISTRY_ENDPOINTS_COMMAND}.`)));
}

const refused = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
suite.check("a listing generation beside an issuance is refused",
  refused(() => permissionsFor("agent", space, principal, { listing, issued: listing })));
suite.check("a listing generation on another profile is refused",
  refused(() => permissionsFor("control-caller-privileged", space, principal, { listing })));
suite.check("listingGrantRows refuses an issued caller", refused(() => listingGrantRows(space, listingCaller, listing)));

suite.finish();
