/**
 * User-mode chat factory smoke (no broker, no auth service). A recording provider registered in the
 * core registry stands in for the auth provider; every case stops before the endpoint starts, so
 * nothing here proves admission, confinement, delivery or any native behavior. What it pins:
 *   - a target that is not user mode, or a provider without the chat methods, refuses UNSUPPORTED
 *     before any provider call;
 *   - a `not-executed` refusal keeps its code, an `executed` one is a failure, and an unknown or
 *     unstated outcome stays unknown and is not retried;
 *   - admission receives only the holder HASH, and names the target's resolved IdP (and, for a remote
 *     mesh only, its exchange URL) for the provider's narrowing check; the exchange and the retirement
 *     receive the secret whose SHA-256 is that hash, for the admitted actor and UID;
 *   - a failed first exchange, or a bearer naming another session, retires the admitted session;
 *   - no failure message or detail carries the holder secret or a bearer.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpEnvelopeError, registry, type AuthProvider, type ChatSessionOpenRequest } from "@cotal-ai/core";
import { CommandFailure, type MeshTarget } from "@cotal-ai/workspace";
import { openUserChatSession } from "../src/chat/user-session.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)?.slice(0, 400)); }
}

const root = mkdtempSync(join(tmpdir(), "cotal-chat-user-"));
const space = "chatuser";
const actor = `chat_${"b".repeat(26)}`;
const lifecycleUid = "c".repeat(26);
const owner = `u_${"a".repeat(26)}`;

const target = (provider: string, mode: MeshTarget["mode"] = "user", remote = false): MeshTarget => ({
  root, server: "nats://127.0.0.1:1", space, mode, tlsRequired: false, personaRoot: join(root, ".cotal", "agents"), source: "registry",
  ...(mode === "user" ? {
    userAuth: {
      provider, idp: { url: "https://idp.invalid", issuer: "https://idp.invalid", audience: "cotal" },
      ...(remote ? { remote: true as const, endpoints: { url: "https://mesh.invalid/cotal" }, sentinelCredsPath: join(root, "sentinel.creds") } : {}),
    },
  } : {}),
});

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const bearer = (claims: { sub: string; actor: string; lifecycleUid: string }): string =>
  `${b64({ alg: "EdDSA" })}.${b64({ sub: claims.sub, act: { actor: claims.actor, lifecycleUid: claims.lifecycleUid }, exp: 2_000_000_000 })}.sig`;

interface Calls { open: ChatSessionOpenRequest[]; bearer: { actor: string; holderProof: string }[]; retire: { actor: string; lifecycleUid: string; holderProof: string }[] }

let n = 0;
function provider(behaviour: { open?: () => Promise<{ actor: string; lifecycleUid: string; expiresAt: number }>; bearer?: () => Promise<{ bearer: string; sentinelCreds: string; exp: number }>; chat?: boolean }): { name: string; calls: Calls } {
  const name = `chat-smoke-${++n}`;
  const calls: Calls = { open: [], bearer: [], retire: [] };
  const p = {
    kind: "auth-provider",
    name,
    ...(behaviour.chat === false ? {} : {
      openChatSession: async (req: ChatSessionOpenRequest) => {
        calls.open.push(req);
        return (behaviour.open ?? (async () => ({ actor, lifecycleUid, expiresAt: 2_000_000_000 })))();
      },
      chatSessionBearer: async (req: { actor: string; holderProof: string }) => {
        calls.bearer.push({ actor: req.actor, holderProof: req.holderProof });
        return (behaviour.bearer ?? (async () => ({ bearer: bearer({ sub: owner, actor, lifecycleUid }), sentinelCreds: "SENTINEL", exp: 2_000_000_000 })))();
      },
      retireChatSession: async (req: { actor: string; lifecycleUid: string; holderProof: string }) => {
        calls.retire.push({ actor: req.actor, lifecycleUid: req.lifecycleUid, holderProof: req.holderProof });
        return { outcome: "retired" as const };
      },
    }),
  };
  registry.register(p as unknown as AuthProvider);
  return { name, calls };
}

const options = { label: "laptop", channels: ["general"], read: ["general"], post: ["general"], ttlSec: 600 };

async function failure(run: () => Promise<unknown>): Promise<CommandFailure | undefined> {
  try { await run(); return undefined; } catch (e) { return e instanceof CommandFailure ? e : undefined; }
}

const leaks = (f: CommandFailure | undefined, secrets: string[]): boolean => {
  const text = JSON.stringify({ message: f?.message, native: f?.native, target: f?.target, remedy: f?.remedy });
  return secrets.some((s) => s !== "" && text.includes(s));
};

async function main(): Promise<void> {
  console.log("1. refusals before any provider call");
  {
    const p = provider({});
    const f = await failure(() => openUserChatSession(target(p.name, "open"), options));
    check("an open target refuses UNSUPPORTED", f?.outcome === "refused" && f.code === "UNSUPPORTED", f?.code);
    const none = provider({ chat: false });
    const g = await failure(() => openUserChatSession(target(none.name), options));
    check("a provider without chat methods refuses UNSUPPORTED", g?.outcome === "refused" && g.code === "UNSUPPORTED", g?.code);
    const h = await failure(() => openUserChatSession(target(p.name), { ...options, channels: ["team.a"] }));
    check("an initial channel outside the read list refuses USAGE_INVALID", h?.code === "USAGE_INVALID", h?.code);
    check("no refusal reached the provider", p.calls.open.length === 0);
  }

  console.log("2. admission outcomes");
  {
    const refused = provider({ open: async () => { throw new EpEnvelopeError("conflict", "16 live sessions", undefined, "not-executed"); } });
    const f = await failure(() => openUserChatSession(target(refused.name), options));
    check("a native refusal keeps its code", f?.outcome === "refused" && f.code === "CONFLICT" && f.native?.code === "conflict", f?.code);
    const unknown = provider({ open: async () => { throw new EpEnvelopeError("unavailable", "no answer", undefined, "unknown"); } });
    const g = await failure(() => openUserChatSession(target(unknown.name), options));
    check("an unknown admission stays unknown", g?.outcome === "unknown" && g.code === "OPERATION_UNKNOWN", g?.code);
    check("an unknown admission is not retried", unknown.calls.open.length === 1);
    const silent = provider({ open: async () => { throw new EpEnvelopeError("conflict", "no stated outcome"); } });
    const h = await failure(() => openUserChatSession(target(silent.name), options));
    check("a refusal that states no outcome is unknown, never a refusal", h?.outcome === "unknown" && h.code === "OPERATION_UNKNOWN", h?.code);
    const wrote = provider({ open: async () => { throw new EpEnvelopeError("permission-denied", "the grant moved", undefined, "executed"); } });
    const i = await failure(() => openUserChatSession(target(wrote.name), options));
    check("an executed refusal is a failure, never a clean refusal", i?.outcome === "failed" && i.code === "OPERATION_FAILED" && i.native?.outcome === "executed", i?.code);
  }

  console.log("3. the holder secret and the retire on a failed first exchange");
  {
    const p = provider({ bearer: async () => { throw new EpEnvelopeError("permission-denied", "the parent moved", undefined, "not-executed"); } });
    const f = await failure(() => openUserChatSession(target(p.name), options));
    const open = p.calls.open[0];
    const proof = p.calls.bearer[0]?.holderProof ?? "";
    check("admission carried a hash, never the secret", open !== undefined && /^[0-9a-f]{64}$/.test(open.holderHash) && !JSON.stringify(open).includes(proof));
    check("the exchanged secret hashes to the admitted holder", proof !== "" && createHash("sha256").update(proof, "utf8").digest("hex") === open?.holderHash);
    check("a local target's open names its IdP and no exchange URL", open?.expect?.idpUrl === "https://idp.invalid" && open.expect.exchangeUrl === undefined, open?.expect);
    check("the failed exchange refuses with the native code", f?.outcome === "refused" && f.code === "PERMISSION_DENIED", f?.code);
    const retired = p.calls.retire[0];
    check("the admitted session was retired with the same secret, actor and UID", retired !== undefined && retired.holderProof === proof && retired.actor === actor && retired.lifecycleUid === lifecycleUid, retired);
    check("the failure carries the close report", JSON.stringify(f?.native?.detail ?? {}).includes("retired"));
    check("no failure text carries the holder secret", !leaks(f, [proof]));
  }
  {
    const wrong = bearer({ sub: owner, actor: `chat_${"z".repeat(26)}`, lifecycleUid });
    const p = provider({ bearer: async () => ({ bearer: wrong, sentinelCreds: "SENTINEL", exp: 2_000_000_000 }) });
    const f = await failure(() => openUserChatSession(target(p.name), options));
    check("a bearer naming another session is refused and the admitted one retired", f !== undefined && p.calls.retire.length === 1, f?.code);
    check("no failure text carries the bearer or the sentinel", !leaks(f, [wrong, "SENTINEL", p.calls.bearer[0]?.holderProof ?? ""]));
  }
  {
    const p = provider({ bearer: async () => { throw new EpEnvelopeError("permission-denied", "refused", undefined, "not-executed"); } });
    await failure(() => openUserChatSession(target(p.name, "user", true), options));
    const open = p.calls.open[0];
    check("a remote target's open names its IdP and its exchange URL", open?.expect?.idpUrl === "https://idp.invalid" && open.expect.exchangeUrl === "https://mesh.invalid/cotal", open?.expect);
  }
}

try {
  await main();
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
