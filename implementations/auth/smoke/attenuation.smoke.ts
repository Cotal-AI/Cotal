/**
 * Delegation-attenuation smoke (broker-free): the ENVELOPE rule over the actor ledger.
 *
 * Everything under an owner stays within the spawner's own grant — a spawn-scoped actor delegates
 * only a SUBSET of what it holds (channel ACLs by pattern containment, capability scope by set
 * inclusion). Pins BOTH enforcement boundaries:
 *  - authorship (`grantManagedActor`): an over-envelope row is never written, and the refusal
 *    names the exact widening re-grant (the operator's repair command);
 *  - agent bearer exchange (`ledgerAuthorizeAgentExchange`): the envelope is a STANDING invariant —
 *    narrowing the spawner refuses its agents' next refresh, revoking the spawner revokes them.
 * Plus the exemptions that make it a delegation rule, not a straitjacket: an admin spawner and a
 * parentless (operator/roster) row are the authority and attenuate nothing.
 * Run: pnpm smoke:auth-attenuation
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  grantActor,
  grantManagedActor,
  revokeActor,
  newActorToken,
  ledgerAuthorizeAgentExchange,
  managedActorLedgerDir,
} from "../src/index.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) {
    failures++;
    console.error(`✗ ${label}`, detail ?? "");
  } else {
    console.log(`✓ ${label}`);
  }
}
function rejects(label: string, fn: () => unknown, needle?: string): string {
  try {
    fn();
    check(`${label} (expected rejection)`, false);
    return "";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(needle && !msg.includes(needle) ? `${label} (rejected but wrong reason: ${msg})` : label, !needle || msg.includes(needle));
    return msg;
  }
}

const dir = mkdtempSync(join(tmpdir(), "cotal-attenuation-"));
const OWNER = `u_${"a".repeat(26)}`; // derived-owner grammar: u_ + 26 × [a-z2-7]
const OTHER = `u_${"b".repeat(26)}`;
const CLI = `${OWNER}.cli`;

try {
  // ---- the spawner: a spawn-scoped human within [general, review.>] ----
  grantActor(dir, {
    owner: OWNER, actor: "cli", scope: ["spawn"],
    allowSubscribe: ["general", "review.>"], allowPublish: ["general"], label: "smoke human",
  });

  // ---- authorship boundary ----
  const within = grantManagedActor(dir, {
    owner: OWNER, actor: "rev", scope: [], parent: CLI,
    allowSubscribe: ["general", "review.pua"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash,
  });
  check("a within-envelope delegation is written (concrete channel under the subtree entry)", within.actor === "rev");
  const recur = grantManagedActor(dir, {
    owner: OWNER, actor: "spawner2", scope: ["spawn"], parent: CLI,
    allowSubscribe: ["review.>"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash,
  });
  check("scope [spawn] delegates within a [spawn] spawner (recursive spawn stays possible)", recur.scope.includes("spawn"));

  const overRead = rejects(
    "an over-envelope READ is refused (ops.secret beyond [general, review.>])",
    () => grantManagedActor(dir, {
      owner: OWNER, actor: "spy", scope: [], parent: CLI,
      allowSubscribe: ["ops.secret"], allowPublish: [], tokenHash: newActorToken().tokenHash,
    }),
    "delegation only narrows",
  );
  check("…the refusal names the exact widening re-grant (full-row upsert: scope+lists+label kept)",
    overRead.includes(`cotal actor grant cli --owner ${OWNER} --scope 'spawn' --allow-subscribe 'general,review.>,ops.secret' --allow-publish 'general' --label 'smoke human'`),
    overRead);
  check("…and no row was written", !existsSync(join(managedActorLedgerDir(dir), `${OWNER}.spy.json`)));
  rejects(
    "a wildcard READ wider than the subtree is refused (review.> ⊅ >)",
    () => grantManagedActor(dir, {
      owner: OWNER, actor: "spy", scope: [], parent: CLI,
      allowSubscribe: [">"], allowPublish: [], tokenHash: newActorToken().tokenHash,
    }),
    "read [>] beyond",
  );
  rejects(
    "an over-envelope POST is refused independently of read",
    () => grantManagedActor(dir, {
      owner: OWNER, actor: "spy", scope: [], parent: CLI,
      allowSubscribe: ["general"], allowPublish: ["review.pua"], tokenHash: newActorToken().tokenHash,
    }),
    "post [review.pua] beyond [general]",
  );
  rejects(
    "an over-envelope SCOPE is refused (admin beyond [spawn]) — the admin-persona pickup is closed",
    () => grantManagedActor(dir, {
      owner: OWNER, actor: "boss", scope: ["admin"], parent: CLI,
      allowSubscribe: ["general"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash,
    }),
    "scope [admin] beyond [spawn]",
  );
  rejects(
    "a cross-owner delegation is refused (agents live under their spawner's owner)",
    () => grantManagedActor(dir, {
      owner: OTHER, actor: "mole", scope: [], parent: CLI,
      allowSubscribe: ["general"], allowPublish: [], tokenHash: newActorToken().tokenHash,
    }),
    "cross-owner",
  );
  const ghostMsg = rejects(
    "an unknown spawner principal is refused (no grant = no delegation authority)",
    () => grantManagedActor(dir, {
      owner: OWNER, actor: "ghostkid", scope: [], parent: `${OWNER}.ghost`,
      allowSubscribe: ["general"], allowPublish: [], tokenHash: newActorToken().tokenHash,
    }),
    "has no grant in this space",
  );
  // A spawner's own ACL is the CEILING for everything spawned under it, so the repair for a missing
  // spawner decides that ceiling. There is no row to copy the ACLs from here, and a printed command
  // carrying invented channel names would fail on paste and push the operator toward deleting the
  // flags, which is `runActor`'s wide default. So this refusal must NAME the two flags and the
  // default in prose, and must NOT ship a runnable command with values it made up.
  const ghostFix = /cotal actor grant [^`]+/.exec(ghostMsg)?.[0] ?? "";
  check(
    "the missing-spawner refusal names both ACL flags and the wide default they fall back to",
    /--allow-subscribe/.test(ghostMsg) && /--allow-publish/.test(ghostMsg) && /WIDE default/.test(ghostMsg),
    ghostMsg,
  );
  check(
    "and the command it prints invents no channel values (no placeholder, no bare `>`)",
    ghostFix.length > 0 && !/[<>]/.test(ghostFix) && !/--allow-(subscribe|publish)/.test(ghostFix),
    ghostFix,
  );
  rejects(
    "a malformed ACL entry is refused at the row WRITE (non-terminal '>' never enters an envelope)",
    () => grantActor(dir, { owner: OWNER, actor: "typo", scope: [], allowSubscribe: ["review.>.x"], allowPublish: [] }),
    "only valid as the last segment",
  );
  rejects(
    "a shell-hostile scope entry is refused at the row WRITE (capability tokens only)",
    () => grantActor(dir, { owner: OWNER, actor: "typo", scope: ["x; touch /tmp/pwn"], allowSubscribe: ["general"], allowPublish: [] }),
    "plain capability token",
  );

  // ---- the exemptions ----
  const boot = grantManagedActor(dir, {
    owner: OWNER, actor: "rosterboot", scope: [], // no parent: operator/roster boot
    allowSubscribe: ["anything.at.all"], allowPublish: ["anything.at.all"], tokenHash: newActorToken().tokenHash,
  });
  check("a parentless row attenuates nothing (the operator is the authority)", boot.allowSubscribe[0] === "anything.at.all");
  grantActor(dir, {
    owner: OTHER, actor: "op", scope: ["admin"], allowSubscribe: ["general"], allowPublish: ["general"],
  });
  const byAdmin = grantManagedActor(dir, {
    owner: OTHER, actor: "wide", scope: ["spawn"], parent: `${OTHER}.op`,
    allowSubscribe: [">"], allowPublish: [">"], tokenHash: newActorToken().tokenHash,
  });
  check("an admin spawner attenuates nothing (operator authority, even beyond its own lists)", byAdmin.allowSubscribe[0] === ">");

  // ---- exchange boundary: the envelope is a STANDING invariant ----
  const { actorToken, tokenHash } = newActorToken();
  grantManagedActor(dir, {
    owner: OWNER, actor: "worker", scope: [], parent: CLI,
    allowSubscribe: ["general", "review.pua"], allowPublish: ["general"], tokenHash,
  });
  const minted = ledgerAuthorizeAgentExchange(dir, OWNER, "worker", actorToken);
  check("a within-envelope agent exchanges (parent rides the grant)", minted.parent === CLI);
  // The operator NARROWS the spawner (upsert) — the already-granted agent's next refresh must refuse.
  grantActor(dir, {
    owner: OWNER, actor: "cli", scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"], label: "smoke human",
  });
  const narrowed = rejects(
    "narrowing the spawner refuses the agent's NEXT exchange (≤ bearer TTL, not never)",
    () => ledgerAuthorizeAgentExchange(dir, OWNER, "worker", actorToken),
    "CURRENT grant",
  );
  check("…naming the widening re-grant back", narrowed.includes("--allow-subscribe 'general,review.pua'"), narrowed);
  // The operator REVOKES the spawner — its agents die with it at their next refresh.
  revokeActor(dir, OWNER, "cli");
  rejects(
    "revoking the spawner revokes its agents at their next exchange",
    () => ledgerAuthorizeAgentExchange(dir, OWNER, "worker", actorToken),
    "no longer granted",
  );
  // Re-grant wide again — the same agent heals with NO respawn (the row itself was never touched).
  grantActor(dir, {
    owner: OWNER, actor: "cli", scope: ["spawn"], allowSubscribe: ["general", "review.>"], allowPublish: ["general"],
  });
  check("re-widening the spawner heals the agent's exchange (row untouched, no respawn needed)",
    ledgerAuthorizeAgentExchange(dir, OWNER, "worker", actorToken).parent === CLI);

  // ---- transitivity: the WHOLE chain must hold, not just the immediate link ----
  const gk = newActorToken();
  grantManagedActor(dir, {
    owner: OWNER, actor: "grandkid", scope: [], parent: `${OWNER}.spawner2`,
    allowSubscribe: ["review.pua"], allowPublish: [], tokenHash: gk.tokenHash,
  });
  check("a grandchild within every link exchanges (cli → spawner2 → grandkid)",
    ledgerAuthorizeAgentExchange(dir, OWNER, "grandkid", gk.actorToken).parent === `${OWNER}.spawner2`);
  revokeActor(dir, OWNER, "cli");
  const revokedMsg = rejects(
    "revoking the ROOT refuses the grandchild's exchange (transitive, not single-hop)",
    () => ledgerAuthorizeAgentExchange(dir, OWNER, "grandkid", gk.actorToken),
    "no longer granted",
  );
  // The widest re-grant in the codebase lives on this branch: the revoke DELETED the row, so
  // `cotal actor list` can no longer show what it held, and an operator re-granting from memory
  // omits a flag and gets `>`. It said only "re-grant it, then respawn" until this cell.
  check(
    "the revoked-spawner refusal warns that an omitted flag on the re-grant comes back WIDE",
    /--allow-subscribe/.test(revokedMsg) && /--allow-publish/.test(revokedMsg) && /WIDE default/.test(revokedMsg),
    revokedMsg,
  );
  rejects(
    "…and the surviving child cannot mint NEW grandchildren under the revoked root",
    () => grantManagedActor(dir, {
      owner: OWNER, actor: "gk2", scope: [], parent: `${OWNER}.spawner2`,
      allowSubscribe: ["review.pua"], allowPublish: [], tokenHash: newActorToken().tokenHash,
    }),
    "has no grant in this space",
  );
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"] });
  rejects(
    "an ANCESTOR narrowed below a deep descendant refuses that descendant's exchange",
    () => ledgerAuthorizeAgentExchange(dir, OWNER, "grandkid", gk.actorToken),
    "CURRENT grant",
  );
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn"], allowSubscribe: ["general", "review.>"], allowPublish: ["general"] });
  check("re-widening the root heals the whole chain",
    ledgerAuthorizeAgentExchange(dir, OWNER, "grandkid", gk.actorToken).parent === `${OWNER}.spawner2`);
  // Legitimate upserts can close a parent LOOP (a parentless root re-parented under its own
  // descendant) — the walk must fail closed on the cycle, not spin or allow.
  const la = newActorToken();
  grantManagedActor(dir, {
    owner: OWNER, actor: "loopa", scope: ["spawn"], allowSubscribe: ["general"], allowPublish: [], tokenHash: la.tokenHash,
  });
  grantManagedActor(dir, {
    owner: OWNER, actor: "loopb", scope: ["spawn"], parent: `${OWNER}.loopa`,
    allowSubscribe: ["general"], allowPublish: [], tokenHash: newActorToken().tokenHash,
  });
  rejects(
    "re-parenting a root under its own descendant is refused (cycle, fail closed)",
    () => grantManagedActor(dir, {
      owner: OWNER, actor: "loopa", scope: ["spawn"], parent: `${OWNER}.loopb`,
      allowSubscribe: ["general"], allowPublish: [], tokenHash: la.tokenHash,
    }),
    "cycle",
  );

  // ---- role delegation: a role is RECEIVE reach (shared task queue), delegated via `role:<r>` ----
  rejects(
    "a child role outside the spawner's scope is refused (role = shared task-queue reach)",
    () => grantManagedActor(dir, {
      owner: OWNER, actor: "taskbot", scope: [], role: "reviewer", parent: CLI,
      allowSubscribe: ["general"], allowPublish: [], tokenHash: newActorToken().tokenHash,
    }),
    "delegated with the `role:reviewer` capability",
  );
  grantActor(dir, {
    owner: OWNER, actor: "cli", scope: ["spawn", "role:reviewer"], allowSubscribe: ["general", "review.>"], allowPublish: ["general"],
  });
  const tb = newActorToken();
  check("the same role within a `role:reviewer` capability is written",
    grantManagedActor(dir, {
      owner: OWNER, actor: "taskbot", scope: [], role: "reviewer", parent: CLI,
      allowSubscribe: ["general"], allowPublish: [], tokenHash: tb.tokenHash,
    }).role === "reviewer");
  grantActor(dir, {
    owner: OWNER, actor: "cli", scope: ["spawn"], allowSubscribe: ["general", "review.>"], allowPublish: ["general"],
  });
  rejects(
    "dropping the role capability refuses the role-holder's NEXT exchange (standing invariant)",
    () => ledgerAuthorizeAgentExchange(dir, OWNER, "taskbot", tb.actorToken),
    `role "reviewer" beyond`,
  );
  rejects(
    "a shell-hostile role is refused at the row write (plain token only)",
    () => grantActor(dir, { owner: OWNER, actor: "roletypo", scope: [], allowSubscribe: ["general"], allowPublish: [], role: "a b'c" }),
    "plain token",
  );

  // ---- the repair command is copy-paste SAFE (free-form fields shell-escaped) ----
  grantActor(dir, {
    owner: OTHER, actor: "op2", scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"], label: "it's dave",
  });
  const escMsg = rejects(
    "an over-envelope delegation under a quoted-label spawner still refuses",
    () => grantManagedActor(dir, {
      owner: OTHER, actor: "kid", scope: [], parent: `${OTHER}.op2`,
      allowSubscribe: ["ops"], allowPublish: [], tokenHash: newActorToken().tokenHash,
    }),
    "delegation only narrows",
  );
  check("…and the repair command shell-escapes the free-form label", escMsg.includes(`--label 'it'\\''s dave'`), escMsg);
  // Unchanged posture: a wrong secret still gets the UNIFORM deny (pre-authentication surface).
  rejects(
    "a wrong secret still gets the uniform pre-auth deny (no envelope detail leaked)",
    () => ledgerAuthorizeAgentExchange(dir, OWNER, "worker", "not-the-token"),
    "unknown agent or wrong secret",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nATTENUATION SMOKE ${failures === 0 ? "OK ✅" : `FAILED ❌ (${failures})`}`);
process.exit(failures ? 1 : 0);
