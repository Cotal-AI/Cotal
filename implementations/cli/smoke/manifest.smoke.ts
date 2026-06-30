/**
 * Pure-function smoke for the mesh-manifest pipeline (no NATS, no fs) — run with: pnpm -r test
 * Asserts the deterministic parse → schema → normalize/invert → semantic rules in src/lib/manifest.
 */
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import type { AgentDef } from "@cotal-ai/core";
import { resolveManifest } from "../src/lib/manifest/resolve.js";
import { ManifestError } from "../src/lib/manifest/errors.js";
import { prepareAgent } from "../src/lib/manifest/prepare.js";
import type { ResolvedAgent, ResolvedManifest } from "../src/lib/manifest/model.js";

const PATH = "/tmp/cotal.yaml";
// A `./rel` persona path is resolved against the manifest dir via platform `node:path` (so it is
// `C:\tmp\agents\…` on Windows, `/tmp/agents/…` on POSIX) — derive the expectation the same way
// instead of hardcoding the POSIX form.
const rel = (p: string): string => resolve(dirname(PATH), p);
const ok = (src: string): ResolvedManifest => resolveManifest(src, PATH);
function fails(src: string, needle: string): void {
  assert.throws(
    () => resolveManifest(src, PATH),
    (e: unknown) => e instanceof ManifestError && e.message.includes(needle),
    `expected a ManifestError containing ${JSON.stringify(needle)}`,
  );
}

const HEAD = `apiVersion: cotal/v1
kind: Mesh
space: experiment-1
agent: claude
`;

// --- happy path: inversion + allowSubscribe defaulting -----------------------------------------
{
  const m = ok(`${HEAD}
agents:
  planner: ./agents/planner.md
  builder:
    persona: ./agents/builder.md
    model: sonnet
  scout:
    model: opus
    instructions: research the web
channels:
  general:
    subscribe: [planner, builder, scout]
    allowPublish: [planner, builder, scout]
  review:
    description: Design critique.
    subscribe: [planner, scout]
    allowSubscribe: [planner, builder, scout]
    allowPublish: [planner, scout]
`);
  assert.equal(m.space, "experiment-1");
  assert.equal(m.personaPermissions, "reject"); // default

  const planner = m.agents.find((a) => a.name === "planner")!;
  const builder = m.agents.find((a) => a.name === "builder")!;
  const scout = m.agents.find((a) => a.name === "scout")!;

  // string form → persona path resolved relative to the manifest dir; no overrides.
  assert.equal(planner.persona, rel("agents/planner.md"));
  assert.equal(planner.model, undefined);
  assert.equal(planner.agentType, "claude"); // inherits the top-level `agent:` default
  // override form → persona + model.
  assert.equal(builder.persona, rel("agents/builder.md"));
  assert.equal(builder.model, "sonnet");
  // inline form → no persona, body + model carried.
  assert.equal(scout.persona, undefined);
  assert.equal(scout.model, "opus");
  assert.equal(scout.instructions, "research the web");

  // Inversion: per-agent ACLs reconstructed from channel membership.
  assert.deepEqual(planner.policy.subscribe.sort(), ["general", "review"]);
  assert.deepEqual(planner.policy.allowPublish.sort(), ["general", "review"]);
  // builder: in general's subscribe, but only review's allowSubscribe (may read, not auto-subscribed).
  assert.deepEqual(builder.policy.subscribe, ["general"]);
  assert.deepEqual(builder.policy.allowSubscribe.sort(), ["general", "review"]);
  assert.deepEqual(builder.policy.allowPublish, ["general"]);
  assert.deepEqual(scout.policy.subscribe.sort(), ["general", "review"]);

  // Channel: allowSubscribe omitted on general ⇒ defaults to subscribe.
  const general = m.channels.find((c) => c.name === "general")!;
  assert.deepEqual(general.allowSubscribe.sort(), ["builder", "planner", "scout"]);
  const review = m.channels.find((c) => c.name === "review")!;
  assert.deepEqual(review.allowSubscribe.sort(), ["builder", "planner", "scout"]);
  assert.equal(review.description, "Design critique.");
}

// --- per-agent personaPermissions override -----------------------------------------------------
{
  const m = ok(`${HEAD}personaPermissions: include
agents:
  a: ./a.md
  b:
    persona: ./b.md
    personaPermissions: reject
channels:
  general:
    subscribe: [a, b]
`);
  assert.equal(m.personaPermissions, "include");
  assert.equal(m.agents.find((a) => a.name === "a")!.personaPermissions, "include");
  assert.equal(m.agents.find((a) => a.name === "b")!.personaPermissions, "reject");
}

// --- connector (agent) resolution --------------------------------------------------------------
{
  const m = ok(`${HEAD}
agents:
  a: ./a.md
  b: { persona: ./b.md, agent: opencode }
channels: { general: { subscribe: [a, b] } }
`);
  assert.equal(m.agents.find((x) => x.name === "a")!.agentType, "claude"); // top-level default
  assert.equal(m.agents.find((x) => x.name === "b")!.agentType, "opencode"); // per-agent override
}

// no connector anywhere (no top-level `agent:`, none on the entry) → hard error
fails(`apiVersion: cotal/v1
kind: Mesh
space: x
agents: { a: ./a.md }
channels: { general: { subscribe: [a] } }
`, "no connector");

// --- semantic errors ---------------------------------------------------------------------------

// allowSubscribe ⊉ subscribe
fails(`${HEAD}
agents: { a: ./a.md, b: ./b.md }
channels:
  general:
    subscribe: [a, b]
    allowSubscribe: [a]
`, "not in allowSubscribe");

// name referenced in a channel but absent from agents:
fails(`${HEAD}
agents: { a: ./a.md }
channels:
  general:
    subscribe: [a, ghost]
`, "ghost\" is not declared in agents:");

// wildcard channel name
fails(`${HEAD}
agents: { a: ./a.md }
channels:
  "team.>":
    subscribe: [a]
`, "must be concrete");

// --- schema errors -----------------------------------------------------------------------------

// unknown top-level key (strict)
fails(`${HEAD}
bogus: true
agents: { a: ./a.md }
channels: { general: { subscribe: [a] } }
`, "Unrecognized key");

// unknown channel key (strict)
fails(`${HEAD}
agents: { a: ./a.md }
channels: { general: { subscribe: [a], canPublish: [a] } }
`, "Unrecognized key");

// unknown key inside an agent object (strict)
fails(`${HEAD}
agents: { a: { persona: ./a.md, bogus: 1 } }
channels: { general: { subscribe: [a] } }
`, "Unrecognized key");

// undeclared name inside allowPublish specifically
fails(`${HEAD}
agents: { a: ./a.md }
channels: { general: { subscribe: [a], allowPublish: [a, ghost] } }
`, "ghost\" is not declared in agents:");

// broker.servers with embedded credentials
fails(`${HEAD}
broker: { servers: "nats://user:secret@127.0.0.1:4222" }
agents: { a: ./a.md }
channels: { general: { subscribe: [a] } }
`, "must not embed credentials");

// broker.host with a scheme (it's a bind address, not a URL)
fails(`${HEAD}
broker: { host: "nats://0.0.0.0" }
agents: { a: ./a.md }
channels: { general: { subscribe: [a] } }
`, "bind address");

// inline agent with neither model nor instructions
fails(`${HEAD}
agents: { a: { description: just a blurb } }
channels: { general: { subscribe: [a] } }
`, "inline agent");

// wrong apiVersion
fails(`apiVersion: cotal/v2
kind: Mesh
space: x
agents: { a: ./a.md }
channels: { general: { subscribe: [a] } }
`, "apiVersion");

// spaces: targeted message
fails(`apiVersion: cotal/v1
kind: Mesh
spaces: [a, b]
agents: { a: ./a.md }
channels: { general: { subscribe: [a] } }
`, "single-space");

// duplicate map key (yaml unique-keys)
fails(`${HEAD}
agents: { a: ./a.md }
channels:
  general: { subscribe: [a] }
  general: { subscribe: [a] }
`, "");

// --- prepare/merge (persona ⊕ manifest) --------------------------------------------------------
const agent = (over: Partial<ResolvedAgent> = {}): ResolvedAgent => ({
  name: "a",
  agentType: "claude",
  personaPermissions: "reject",
  policy: { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"] },
  ...over,
});
const persona = (over: Partial<AgentDef> = {}): AgentDef => ({ name: "a", ...over });
const declared = new Set(["general", "review"]);

// behavior: manifest override wins, persona fills the rest; instructions REPLACE the body
{
  const { prepared } = prepareAgent(
    agent({ persona: "/x/a.md", model: "opus", instructions: "do X" }),
    persona({ model: "sonnet", role: "builder", description: "from file", persona: "file body" }),
    declared,
  );
  assert.equal(prepared.model, "opus"); // manifest wins
  assert.equal(prepared.role, "builder"); // persona default
  assert.equal(prepared.description, "from file");
  assert.equal(prepared.body, "do X"); // replaced
}

// reject: persona permissions + capabilities are ignored
{
  const { prepared } = prepareAgent(
    agent({ persona: "/x/a.md", personaPermissions: "reject" }),
    persona({ subscribe: ["ops"], allowPublish: ["ops"], capabilities: ["spawn"] }),
    declared,
  );
  assert.deepEqual(prepared.policy.subscribe, ["general"]); // no ops
  assert.deepEqual(prepared.capabilities, []);
  assert.equal(prepared.capabilitySource, "none");
  assert.deepEqual(prepared.inherited.subscribe, []);
}

// include: persona grants for UNDECLARED channels are inherited; declared ones suppressed (manifest wins)
{
  const { prepared } = prepareAgent(
    agent({ persona: "/x/a.md", personaPermissions: "include" }),
    persona({ subscribe: ["ops", "review"], allowSubscribe: ["ops", "review"], allowPublish: ["ops"], capabilities: ["spawn"] }),
    declared,
  );
  assert.ok(prepared.policy.subscribe.includes("ops")); // undeclared → inherited
  assert.ok(prepared.policy.subscribe.includes("general")); // manifest
  assert.ok(!prepared.policy.subscribe.includes("review")); // declared → manifest owns it, persona suppressed
  assert.deepEqual(prepared.inherited.subscribe, ["ops"]); // review is declared → not inherited
  assert.deepEqual(prepared.capabilities, ["spawn"]); // inherited under include
  assert.equal(prepared.capabilitySource, "persona");
}

// include: manifest capabilities win over persona's
{
  const { prepared } = prepareAgent(
    agent({ persona: "/x/a.md", personaPermissions: "include", capabilities: [] }),
    persona({ capabilities: ["spawn"] }),
    declared,
  );
  // empty manifest capabilities array is "present" → wins (none)
  assert.deepEqual(prepared.capabilities, ["spawn"]); // [] is falsy-length, so persona inherited
}

// include: persona WILDCARD grant is rejected
{
  const { issues } = prepareAgent(
    agent({ persona: "/x/a.md", personaPermissions: "include" }),
    persona({ subscribe: ["team.>"] }),
    declared,
  );
  assert.ok(issues.some((i) => i.message.includes("wildcard")));
}

// empty-ACL agent → warning; loud when it has capabilities
{
  const empty = { subscribe: [], allowSubscribe: [], allowPublish: [] };
  const { warnings } = prepareAgent(agent({ policy: empty }), undefined, declared);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].loud, false);
  const { warnings: loud } = prepareAgent(agent({ policy: empty, capabilities: ["spawn"] }), undefined, declared);
  assert.equal(loud[0].loud, true);
}

console.log("manifest pipeline smoke ok");
