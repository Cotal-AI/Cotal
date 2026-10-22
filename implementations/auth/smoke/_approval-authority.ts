/** A test-only conversation-identity authority that answers connection approval v1 over real HTTPS.
 * A request issues nothing until the fixture person decides it through `decide`, which stands for
 * the authority's own signed-in page and is never reachable by a client. Only the replay after an
 * approval writes a local mesh's ledger row and broker durables, through the managed grant a real
 * spawn writes, for exactly the approved selection. Retirement revokes first and finishes the broker
 * footprint once `retirement.driverRan` is set, as the hosted route does. Load it after `COTAL_HOME`
 * is set. Never imported by shipped code; no hosted acceptance is claimed. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  canonicalJson, deprovisionAgent, eventChannel, mintCreds, mintLifecycleUid, newIdentity, principalKey, provisionAgentDurables,
  type ConversationSelection, type CotalEndpoint,
} from "@cotal-ai/core";
import { recordMesh, type assertUserAuthInfo } from "@cotal-ai/workspace";
import { grantManagedActor, revokeManagedActor } from "@cotal-ai/auth";

type Approved = ConversationSelection;
/** What a person who approves nothing optional approves: a concrete empty selection, never null. */
export const EMPTY: Approved = { v: 1, channels: [], role: null, capabilities: [], endpoints: [] };

/** The ledger and broker a local mesh's approved identity is issued into. */
export interface LocalIssuer {
  stateDir: string;
  provisioner: CotalEndpoint;
  auth: Parameters<typeof mintCreds>[0];
  servers: string;
}

export interface FixtureRequest {
  space: string;
  requestId: string;
  label: string;
  tokenHash: string;
  digest: string;
  proposed: ConversationSelection | null;
  approval: { id: string; url: string; expiresAt: string };
  state: "pending" | "approved" | "denied" | "expired" | "issued";
  approved?: Approved;
  decidedAt?: string;
  actor?: string;
  lifecycleUid?: string;
  material?: Record<string, unknown>;
  phase?: "live" | "retired" | "terminal";
}

export interface ApprovalAuthority {
  readonly base: string;
  /** Trust it in a child process with `NODE_EXTRA_CA_CERTS`. */
  readonly caFile: string;
  readonly requests: ReadonlyMap<string, FixtureRequest>;
  readonly counts: { posts: number; issues: number; deletes: number; foreignDeletes: number };
  /** `slow` retirements each answer after 35 s, past the client's own request deadline. */
  readonly retirement: { driverRan: boolean; slow: number; served: number };
  /** Serve a mesh's discovery and identities, and record it in the workspace as a signed-in mesh.
   *  `exchange` is the auth service's public exchange URL; `local` issues into a real ledger. */
  addMesh(mesh: {
    space: string; server: string; root: string; owner: string; userAuth: ReturnType<typeof assertUserAuthInfo>; sentinelCreds: string;
    exchange?: string; local?: LocalIssuer; selection?: boolean;
  }): void;
  /** The fixture person's decision in the authority's own page. */
  decide(requestId: string, decision: { approve: Approved } | "deny" | "expire"): void;
  /** Requests still waiting for the person, optionally for one requested name. */
  pending(label?: string): FixtureRequest[];
  close(): Promise<void>;
}

const base32 = (n: number) => Array.from(randomBytes(n), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("");
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const read = async (req: IncomingMessage) => { let raw = ""; for await (const chunk of req) raw += chunk; return raw; };
// Written out from the frozen contract rather than computed by the client's own helper.
const contractGrant = (owner: string, actor: string, s: Approved) => ({
  scope: [...s.capabilities], role: s.role, allowSubscribe: s.channels.map((c) => c.channel),
  allowPublish: [eventChannel({ owner, actor }), ...s.channels.filter((c) => c.access === "read-post").map((c) => c.channel)],
  subscribe: [], endpoints: [] as [],
});

/** `human` is the fixture human session every authenticated request must present. */
export async function startApprovalAuthority(o: { home: string; human: string }): Promise<ApprovalAuthority> {
  const key = join(o.home, "authority.key"), caFile = join(o.home, "authority.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", caFile], { stdio: "ignore" });
  type Mesh = { owner: string; bundle: Record<string, unknown>; exchange?: string; local?: LocalIssuer };
  const meshes = new Map<string, Mesh>();
  const requests = new Map<string, FixtureRequest>();
  const counts = { posts: 0, issues: 0, deletes: 0, foreignDeletes: 0 };
  const retirement = { driverRan: true, slow: 0, served: 0 };
  let base = "";

  const issue = async (row: FixtureRequest, mesh: Mesh) => {
    const actor = `pa_${base32(26)}`, lifecycleUid = mintLifecycleUid(), owner = mesh.owner;
    const grant = contractGrant(owner, actor, row.approved!);
    if (mesh.local) {
      grantManagedActor(mesh.local.stateDir, { owner, actor, scope: grant.scope, ...(grant.role ? { role: grant.role } : {}),
        allowSubscribe: grant.allowSubscribe, allowPublish: grant.allowPublish, parent: `${owner}.cli`, label: row.label,
        tokenHash: row.tokenHash, lifecycleUid, custody: { kind: "foreground" } });
      await provisionAgentDurables(mesh.local.provisioner, { owner, actor, lifecycleUid },
        { subscribe: [], allowSubscribe: grant.allowSubscribe, ...(grant.role ? { role: grant.role } : {}) });
    }
    Object.assign(row, { state: "issued", actor, lifecycleUid, phase: "live", material: {
      v: 1, requestId: row.requestId, space: row.space, owner, actor, lifecycleUid, grant, policy: { events: "required" },
      sentinelCreds: mesh.bundle.sentinelCreds, exchangeUrl: `${base}/s/${row.space}`,
      retire: { url: `${base}/api/spaces/${row.space}/conversation-identities/${actor}?lifecycleUid=${lifecycleUid}` },
      approval: { id: row.approval.id, decidedAt: row.decidedAt, approved: row.approved } } });
    counts.issues++;
  };

  const retire = async (row: FixtureRequest, mesh: Mesh) => {
    if (retirement.slow > 0) { retirement.slow--; await wait(35_000); retirement.served++; }
    if (row.phase === "live") { if (mesh.local) revokeManagedActor(mesh.local.stateDir, mesh.owner, row.actor!); row.phase = "retired"; }
    if (row.phase === "retired" && retirement.driverRan) {
      if (mesh.local) {
        const target = principalKey(mesh.owner, row.actor!).key;
        const creds = await mintCreds(mesh.local.auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: target, lifecycleUid: row.lifecycleUid! } });
        await deprovisionAgent({ servers: mesh.local.servers, space: row.space, targetId: target, lifecycleUid: row.lifecycleUid!, creds });
      }
      row.phase = "terminal";
    }
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(caFile) }, (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    void (async () => {
      const url = new URL(req.url!, base);
      const discovery = /^\/s\/([^/]+)\/\.well-known\/cotal-mesh$/.exec(url.pathname);
      if (req.method === "GET" && discovery && meshes.has(discovery[1]!)) return send(200, meshes.get(discovery[1]!)!.bundle);
      const exchange = /^\/s\/([^/]+)\/exchange$/.exec(url.pathname);
      const forward = exchange ? meshes.get(exchange[1]!)?.exchange : undefined;
      if (req.method === "POST" && forward) {
        const answer = await fetch(forward, { method: "POST", headers: { "content-type": "application/json" }, body: await read(req) });
        res.writeHead(answer.status, { "content-type": "application/json" });
        return res.end(await answer.text());
      }
      if (req.headers.authorization !== `Bearer ${o.human}`) return send(401, { error: "unauthenticated" });
      const route = /^\/api\/spaces\/([^/]+)\/conversation-identities(?:\/([^/]+))?$/.exec(url.pathname);
      const mesh = route ? meshes.get(route[1]!) : undefined;
      if (!route || !mesh) return send(404, {});
      const at = route[1]!;
      if (req.method === "POST" && !route[2]) {
        const body = JSON.parse(await read(req)) as { requestId: string; tokenHash: string; label: string; selection?: ConversationSelection };
        counts.posts++;
        const digest = canonicalJson(body);
        let row = requests.get(body.requestId);
        if (row && (row.digest !== digest || row.space !== at)) return send(409, { error: "requestId reused with a different request" });
        if (!row) {
          const id = base32(26);
          row = { space: at, requestId: body.requestId, label: body.label, tokenHash: body.tokenHash, digest, proposed: body.selection ?? null,
            approval: { id, url: `${base}/approve/${id}`, expiresAt: new Date(Date.now() + 600_000).toISOString() }, state: "pending" };
          requests.set(body.requestId, row);
        }
        if (row.state === "pending") return send(202, { v: 1, requestId: row.requestId, status: "pending", approval: row.approval, proposed: row.proposed });
        if (row.state === "denied") return send(403, { status: "denied" });
        if (row.state === "expired") return send(410, { status: "expired" });
        let status = 200;
        if (row.state === "approved") { await issue(row, mesh); status = 201; }
        return send(status, row.material);
      }
      if (req.method === "DELETE" && route[2]) {
        const row = [...requests.values()].find((r) => r.space === at && r.actor === route[2] && url.searchParams.get("lifecycleUid") === r.lifecycleUid);
        if (!row) return send(404, { error: "unknown lifecycle" });
        if (mesh.local) counts.deletes++; else counts.foreignDeletes++;
        await retire(row, mesh);
        return row.phase === "terminal"
          ? send(200, { v: 1, actor: row.actor, lifecycleUid: row.lifecycleUid, phase: "terminal", complete: true })
          : send(202, { v: 1, actor: row.actor, lifecycleUid: row.lifecycleUid, phase: "retired", complete: false });
      }
      send(404, {});
    })().catch((error) => { console.error("fixture authority failed:", error); if (!res.headersSent) send(500, { error: "fixture failure" }); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base, caFile, requests, counts, retirement,
    addMesh(m) {
      const userAuth = { ...m.userAuth, endpoints: { url: `${base}/s/${m.space}` } };
      meshes.set(m.space, { owner: m.owner, exchange: m.exchange, local: m.local, bundle: {
        space: m.space, server: m.server, tlsRequired: false, userAuth, policy: { events: "required" }, sentinelCreds: m.sentinelCreds,
        cloudCapabilities: { conversationIdentity: { version: 1, url: `${base}/api/spaces/${m.space}/conversation-identities` },
          connectionApproval: { version: 1 }, ...(m.selection ? { conversationIdentitySelection: { version: 1 } } : {}) } } });
      recordMesh({ space: m.space, server: m.server, root: m.root, mode: "user", origin: "manual", policy: { events: "required" },
        userAuth: { ...userAuth, remote: true }, ts: new Date().toISOString() });
    },
    decide(requestId, decision) {
      const row = requests.get(requestId);
      if (row?.state !== "pending") throw new Error("the fixture person can decide only a pending request");
      if (decision === "deny") row.state = "denied";
      else if (decision === "expire") row.state = "expired";
      else Object.assign(row, { state: "approved", approved: decision.approve, decidedAt: new Date().toISOString() });
    },
    pending: (label) => [...requests.values()].filter((r) => r.state === "pending" && (label === undefined || r.label === label)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
