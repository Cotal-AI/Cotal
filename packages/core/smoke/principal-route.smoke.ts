/**
 * The principal route and the `agent` endpoint, broker-free (SPEC 13.21, 13.22): the subject
 * grammar, the parser branch and the sentinel; the `authorities` field of a cluster command and
 * its parse refusals (cell 26); the envelope agreement branch (cells 9 and 21); the serve-side
 * construction refusals (cell 23); the row builders; the two mint arms and every profile that
 * gets nothing; and the maximum-capability credential's size with the new rows.
 *
 * The cells that need a broker run in `pnpm smoke:principal-route:auth`.
 *
 * Run: pnpm smoke:principal-route   (no broker; part of smoke:ci)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeUser } from "@nats-io/jwt";
import { createAccount, createUser } from "@nats-io/nkeys";
import {
  AGENT_CLUSTER, AGENT_CONTRACTS, AGENT_ENDPOINT, AGENT_COMMANDS, EP_PRINCIPAL_AUTHORITIES, MAX_MINTED_JWT_BYTES,
  agentClusterArtifacts, agentPromptDigest, assertRuntimeToken, buildClusterDocument, checkRequestSubjectAgreement,
  epPrincipalCallerReplyFilter, epPrincipalGrantRows, epPrincipalNoRespondersSubject, epPrincipalOwnerGrantRows,
  epPrincipalReplySubject, epPrincipalRequestSubject, epPrincipalServeFilter, epPrincipalServeGrantRows, epServeGrantRows,
  isPrincipalAuthority, mintLifecycleUid, parseClusterDocument, parseEndpointRequest, parseEpSubject, permissionsFor,
  principalRouteCommands, isAgentCommandName, EpEnvelopeError, ContractInvalidError,
  type EndpointRequest, type EpCaller, type EpCapability, type EpPrincipal, type ParsedEpPrincipalRequest, type PromptContent,
} from "../src/index.js";
import * as coreRoot from "../src/index.js";
import { servePrincipalRoute } from "../src/endpoint-serve.js";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const throws = (name: string, fn: () => unknown, match?: RegExp | string) => {
  try { fn(); check(name, false, "did not throw"); }
  catch (e) {
    const msg = e instanceof Error ? `${(e as { code?: string }).code ?? ""} ${e.message}` : String(e);
    check(name, match === undefined || (typeof match === "string" ? msg.includes(match) : match.test(msg)), msg);
  }
};
const refusedWith = (name: string, fn: () => unknown, code: string) => {
  try { fn(); check(name, false, "did not throw"); }
  catch (e) { check(name, e instanceof EpEnvelopeError && e.code === code, e instanceof Error ? `${(e as EpEnvelopeError).code} ${e.message}` : e); }
};

const SPACE = "demo";
const P = `cotal.${SPACE}`;
const UID = "u".repeat(26), UID2 = "w".repeat(26), CUID = "c".repeat(26);
const RT = "3f2a0c4e-8b1d-4c7a-9e2f-5d6b7a8c9d0e";
const NONCE = "N".repeat(32);
const agent: EpPrincipal = { owner: "u_alice", actor: "coder", uid: UID, runtimeId: RT };
const web: EpCaller = { owner: "u_alice", actor: "web", uid: CUID };

// ── the subject grammar (SPEC 13.21) ──
const req = epPrincipalRequestSubject(SPACE, { endpoint: AGENT_ENDPOINT, principal: agent, command: "prompt-answer", authority: "owner", caller: web, nonce: NONCE });
check("request: the 15-token form, head before command and authority word",
  req === `${P}.ep.prin.agent.u_alice.coder.${UID}.${RT}.prompt-answer.owner.u_alice.web.${CUID}.${NONCE}` && req.split(".").length === 15, req);
const reply = epPrincipalReplySubject(SPACE, { endpoint: AGENT_ENDPOINT, principal: agent, caller: web, nonce: NONCE });
check("reply: the 13-token form, the serving head then the caller and nonce",
  reply === `${P}.ep.prin-reply.agent.u_alice.coder.${UID}.${RT}.u_alice.web.${CUID}.${NONCE}` && reply.split(".").length === 13, reply);
const sentinel = epPrincipalNoRespondersSubject(SPACE, web, NONCE);
check("sentinel: the reply form with _nr in all five head positions",
  sentinel === `${P}.ep.prin-reply._nr._nr._nr._nr._nr.u_alice.web.${CUID}.${NONCE}`, sentinel);
check("serve filter: own head, every command, word, caller and nonce, no queue",
  epPrincipalServeFilter(SPACE, AGENT_ENDPOINT, agent) === `${P}.ep.prin.agent.u_alice.coder.${UID}.${RT}.*.*.*.*.*.*`);
check("caller reply read: any head, own caller triple, one nonce or any",
  epPrincipalCallerReplyFilter(SPACE, web, NONCE) === `${P}.ep.prin-reply.*.*.*.*.*.u_alice.web.${CUID}.${NONCE}`
  && epPrincipalCallerReplyFilter(SPACE, web) === `${P}.ep.prin-reply.*.*.*.*.*.u_alice.web.${CUID}.*`);
const wild = (t: string) => t.split(".").includes("*") || t.includes(">");
check("the sentinel is inside the caller's own reply read: one subscription hears the reply and the 503",
  !wild(sentinel) && sentinel.split(".").length === epPrincipalCallerReplyFilter(SPACE, web, NONCE).split(".").length);

const parsed = parseEpSubject(req);
check("parse: a principal request is its own plane with head, command, word, caller and nonce",
  parsed?.plane === "principal-request" && parsed.endpoint === "agent" && parsed.principal.owner === "u_alice" && parsed.principal.actor === "coder"
  && parsed.principal.uid === UID && parsed.principal.runtimeId === RT && parsed.command === "prompt-answer" && parsed.authority === "owner"
  && parsed.caller.owner === "u_alice" && parsed.caller.actor === "web" && parsed.caller.uid === CUID && parsed.nonce === NONCE, parsed);
const parsedReply = parseEpSubject(reply);
check("parse: a principal reply is its own plane", parsedReply?.plane === "principal-reply" && parsedReply.principal.runtimeId === RT && parsedReply.nonce === NONCE);
check("parse: the sentinel is no reply (no lifecycle UID in its head)", parseEpSubject(sentinel) === null);
check("parse: a word outside the closed set is no shape", parseEpSubject(req.replace(".owner.", ".exact.")) === null && parseEpSubject(req.replace(".owner.", ".self.")) === null);
check("parse: one token more or less is no shape", parseEpSubject(`${req}.x`) === null && parseEpSubject(req.split(".").slice(0, 14).join(".")) === null
  && parseEpSubject(`${reply}.x`) === null && parseEpSubject(reply.split(".").slice(0, 12).join(".")) === null);
check("parse: the route has no versioned form", parseEpSubject(req.replace(".ep.prin.", ".ep.v1.prin.")) === null);
check("parse: a service-route reader never sees a request or reply plane here",
  [req, reply].every((s) => { const p = parseEpSubject(s); return p !== null && p.plane !== "request" && p.plane !== "reply"; }));

throws("a wildcard in the head is refused by the builder", () => epPrincipalRequestSubject(SPACE, { endpoint: AGENT_ENDPOINT, principal: { ...agent, actor: "*" }, command: "prompts", authority: "owner", caller: web, nonce: NONCE }));
throws("_nr is no lifecycle UID, so no head can name the sentinel's", () => epPrincipalReplySubject(SPACE, { endpoint: AGENT_ENDPOINT, principal: { ...agent, uid: "_nr" }, caller: web, nonce: NONCE }));
throws("a runtime id outside [A-Za-z0-9_-]{1,64} is refused", () => assertRuntimeToken("rt.with.dots"));
throws("a 65-character runtime id is refused", () => assertRuntimeToken("r".repeat(65)));
check("a presence runtime id (a UUID) is a runtime token", assertRuntimeToken(RT) === RT);
throws("an authority word outside the closed set is refused by the builder",
  () => epPrincipalRequestSubject(SPACE, { endpoint: AGENT_ENDPOINT, principal: agent, command: "prompts", authority: "exact" as never, caller: web, nonce: NONCE }));
check("the closed set is owner and grant, frozen, and read from a private copy",
  EP_PRINCIPAL_AUTHORITIES.join() === "owner,grant" && Object.isFrozen(EP_PRINCIPAL_AUTHORITIES) && isPrincipalAuthority("grant") && !isPrincipalAuthority("exact"));

// ── the `authorities` field of a cluster command (SPEC 13.7, 13.21; cell 26) ──
const D = `sha256:${"a".repeat(64)}`;
const doc = (cmd: Record<string, unknown>) => ({ urn: "ai.cotal.test", revision: 1, attributes: [], events: [],
  commands: [{ name: "prompts", class: "ephemeral", targeted: false, capability: "agent.prompts.read", inputDigest: D, outputDigest: D, ...cmd }] });
check("parse admits a non-empty set of distinct words on an untargeted command",
  parseClusterDocument(doc({ authorities: ["owner", "grant"] })).commands[0].authorities?.join() === "owner,grant");
const invalid = (name: string, cmd: Record<string, unknown>) => {
  try { parseClusterDocument(doc(cmd)); check(name, false, "parsed"); }
  catch (e) { check(name, e instanceof ContractInvalidError, (e as Error).message); }
};
invalid("cell 26: authorities with targeted: true is contract-invalid", { targeted: true, modes: ["owner"], authorities: ["owner"] });
invalid("cell 26: authorities beside modes is contract-invalid", { modes: ["owner"], authorities: ["owner"] });
invalid("cell 26: an empty authorities list is contract-invalid", { authorities: [] });
invalid("cell 26: an unknown authority word is contract-invalid", { authorities: ["owner", "admin"] });
invalid("a word named twice is contract-invalid", { authorities: ["owner", "owner"] });
invalid("authorities that is not an array is contract-invalid", { authorities: "owner" });
check("the builder writes authorities, and a row without it writes none",
  buildClusterDocument("ai.cotal.test", 1, [{ name: "a", targeted: false, authorities: ["owner"], capability: "x.y", input: {}, output: {} },
    { name: "b", targeted: false, capability: "x.y", input: {}, output: {} }]).commands.map((c) => c.authorities?.join() ?? "-").join("|") === "owner|-");

// ── the `agent` cluster, revision 2 (SPEC 13.22) ──
const agentDoc = parseClusterDocument(structuredClone(AGENT_CLUSTER));
check("the agent cluster is ai.cotal.agent revision 2 with prompts, prompt, prompt-answer, commands and command",
  agentDoc.urn === "ai.cotal.agent" && agentDoc.revision === 2 && agentDoc.commands.map((c) => c.name).join() === "prompts,prompt,prompt-answer,commands,command");
check("every command is ephemeral, untargeted and without modes",
  agentDoc.commands.every((c) => c.class === "ephemeral" && c.targeted === false && c.modes === undefined));
check("the prompt commands admit owner and grant, and commands and command admit owner only",
  agentDoc.commands.map((c) => `${c.name}:${c.authorities?.join("+")}`).join() === "prompts:owner+grant,prompt:owner+grant,prompt-answer:owner+grant,commands:owner,command:owner",
  agentDoc.commands.map((c) => `${c.name}:${c.authorities?.join("+")}`));
check("capabilities: prompt reads, the answer, the command list and a command run",
  agentDoc.commands.map((c) => c.capability).join() === "agent.prompts.read,agent.prompts.read,agent.prompts.answer,agent.commands.read,agent.commands.run");
check("the declared digests are the compiled contracts' closure digests",
  agentDoc.commands.every((c) => AGENT_CONTRACTS[c.name].input.closureDigest === c.inputDigest && AGENT_CONTRACTS[c.name].output.closureDigest === c.outputDigest));
check("the cluster constant, its commands and its schemas are frozen",
  Object.isFrozen(AGENT_CLUSTER) && Object.isFrozen(AGENT_CLUSTER.commands) && AGENT_COMMANDS.every((r) => Object.isFrozen(r.input) && Object.isFrozen(r.output)));
check("the closure digest is stable across calls", agentClusterArtifacts().closureDigest === agentClusterArtifacts().closureDigest);

const cmdIn = AGENT_CONTRACTS.command.input.validate, cmdOut = AGENT_CONTRACTS.command.output.validate;
const listIn = AGENT_CONTRACTS.commands.input.validate, listOut = AGENT_CONTRACTS.commands.output.validate;
const NAMES: [unknown, boolean][] = [["review", true], ["sub/nested", true], ["émoji😀", true], ["x".repeat(128), true], ["x".repeat(129), false],
  ["", false], ["has space", false], ["tab\tx", false], ["zero\u200bwidth", false], ["line\nbreak", false], [7, false]];
check("command takes { target, name, args? } and nothing else",
  cmdIn({ target: "command", name: "review" }) && cmdIn({ target: "skill", name: "browser", args: "a\nb" }) && cmdIn({ target: "command", name: "review", args: "" })
  && !cmdIn({ target: "agent", name: "review" }) && !cmdIn({ name: "review" }) && !cmdIn({ target: "command" }) && !cmdIn({ target: "command", name: "review", args: 1 })
  && !cmdIn({ target: "command", name: "review", agent: "u_alice.coder" }));
check("a command name is 1 to 128 characters with no whitespace and none of Unicode category C, in the schema and in isAgentCommandName",
  NAMES.every(([name, ok]) => cmdIn({ target: "command", name }) === ok && isAgentCommandName(name) === ok), NAMES.map(([n]) => [n, cmdIn({ target: "command", name: n }), isAgentCommandName(n)]));
check("command answers {} and nothing else", cmdOut({}) && !cmdOut({ started: true }) && !cmdOut(null));
const entry = (e: Record<string, unknown> = {}) => ({ supported: true, commands: [{ name: "review", target: "command", ...e }] });
check("commands takes {} and answers { supported: false } or { supported: true, commands }",
  listIn({}) && !listIn({ target: "skill" }) && listOut({ supported: false }) && listOut({ supported: true, commands: [] }) && listOut(entry({ description: "d", inputHint: "[pr]" }))
  && !listOut({ supported: false, commands: [] }) && !listOut({ supported: true }) && !listOut({}));
check("a listed entry carries name, target, description and inputHint only: no path, content or other field a harness keeps",
  !listOut(entry({ path: "/x/SKILL.md" })) && !listOut(entry({ content: "SKILL-BODY" })) && !listOut(entry({ id: "x" })) && !listOut(entry({ target: "agent" }))
  && !listOut(entry({ name: "has space" })) && !listOut(entry({ description: "" })));
check("a description is at most 1024 characters, an input hint at most 256, and a list at most 512 entries",
  listOut(entry({ description: "d".repeat(1024), inputHint: "h".repeat(256) })) && !listOut(entry({ description: "d".repeat(1025) })) && !listOut(entry({ inputHint: "h".repeat(257) }))
  && listOut({ supported: true, commands: Array.from({ length: 512 }, (_, i) => ({ name: `c${i}`, target: "command" })) })
  && !listOut({ supported: true, commands: Array.from({ length: 513 }, (_, i) => ({ name: `c${i}`, target: "command" })) }));

const TS = "2026-11-17T10:00:00.000Z";
const content: PromptContent = {
  kind: "permission", title: "Allow Bash: npm test?",
  subject: { type: "tool", name: "Bash", input: { kind: "shown", value: { command: "npm test" } }, cwd: "/work" },
  options: [{ id: "allow", label: "Allow", effect: "proceed" }, { id: "deny", label: "Deny", effect: "refuse", note: "optional" }],
  source: { harness: "claude-code", scope: "main" },
};
const prompt = { id: "a".repeat(26), digest: agentPromptDigest(content), openedAt: TS, expiresAt: TS, state: { kind: "open" }, content };
const out = (cmd: string, v: unknown) => AGENT_CONTRACTS[cmd].output.validate(v);
check("a full prompt validates, and its digest is SHA-256 of the RFC 8785 content", out("prompt", { prompt }) && /^sha256:[0-9a-f]{64}$/.test(prompt.digest));
check("a question with a form in the profile validates", out("prompt", { prompt: { ...prompt, content: {
  kind: "question", title: "Which branch?", options: [{ id: "submit", label: "Submit", effect: "proceed", form: "required" }, { id: "dismiss", label: "Dismiss", effect: "refuse" }],
  form: { schema: { type: "object", required: ["branch"], properties: {
    branch: { type: "string", oneOf: [{ const: "main", title: "main", description: "the release branch" }, { const: "dev", title: "dev" }] },
    tags: { type: "array", items: { anyOf: [{ const: "a", title: "A" }] }, minItems: 1, maxItems: 2 },
    count: { type: "integer", minimum: 1, default: 2 }, note: { type: "string", maxLength: 80, format: "uri" }, ok: { type: "boolean", default: true },
  } } } } } }));
check("a form with a nested object is outside the profile", !out("prompt", { prompt: { ...prompt, content: { ...content, form: { schema: { type: "object", properties: { n: { type: "object", properties: {} } } } } } } }));
check("a title with a line break is refused", !out("prompt", { prompt: { ...prompt, content: { ...content, title: "line\nbreak" } } }));
check("17 options are refused, and so is none", !out("prompt", { prompt: { ...prompt, content: { ...content, options: Array.from({ length: 17 }, (_, i) => ({ id: `o${i}`, label: "x", effect: "proceed" })) } } })
  && !out("prompt", { prompt: { ...prompt, content: { ...content, options: [] } } }));
check("a timestamp not in the one 24-byte form is refused", !out("prompt", { prompt: { ...prompt, openedAt: "2026-11-17T10:00:00Z" } }));
check("an unknown field anywhere is refused (closed schemas)", !out("prompt", { prompt: { ...prompt, extra: 1 } }) && !out("prompt", { prompt: { ...prompt, content: { ...content, extra: 1 } } }));
check("a typed subject needs a reverse-DNS type, so it never reads as a tool", !out("prompt", { prompt: { ...prompt, content: { ...content, subject: { type: "tool", data: 1 } } } })
  && out("prompt", { prompt: { ...prompt, content: { ...content, subject: { type: "com.example.thing", data: { a: 1 } } } } }));
const answer = { by: { id: "u_alice.web", uid: CUID, authority: "owner" }, option: "deny", effect: "refuse", at: TS };
check("every state of revision 1 validates", [
  { kind: "open" }, { kind: "sent", answer, delivery: "unconfirmed" }, { kind: "sent", answer, delivery: "delivered" },
  { kind: "closed", at: TS, outcome: { kind: "answered", answer } },
  { kind: "closed", at: TS, outcome: { kind: "unconfirmed", answer, seen: { tie: "subject", effect: "proceed" } } },
  { kind: "closed", at: TS, outcome: { kind: "undelivered", answer } },
  { kind: "closed", at: TS, outcome: { kind: "local", seen: { tie: "prompt", effect: "proceed" }, late: answer } },
  { kind: "closed", at: TS, outcome: { kind: "withdrawn", seen: { tie: "none" } } },
  { kind: "closed", at: TS, outcome: { kind: "expired" } },
].every((state) => out("prompt-answer", { state })));
check("an answer by an authority outside the closed set is refused", !out("prompt-answer", { state: { kind: "sent", answer: { ...answer, by: { ...answer.by, authority: "exact" } }, delivery: "unconfirmed" } }));
const summary = { id: prompt.id, digest: prompt.digest, openedAt: TS, expiresAt: TS, state: { kind: "open" }, kind: "permission", title: content.title, contentBytes: 10 };
const closedSummary = { ...summary, state: { kind: "closed", at: TS, outcome: { kind: "expired" } } };
const runtime = { id: RT, startedAt: 1 };
check("prompts: 32 open and 32 closed validate, 33 do not",
  out("prompts", { runtime, seq: 0, open: Array(32).fill(summary), closed: Array(32).fill(closedSummary) })
  && !out("prompts", { runtime, seq: 0, open: Array(33).fill(summary), closed: [] }));
check("prompts: open holds open or sent prompts and closed holds closed ones, and neither list takes the other's",
  out("prompts", { runtime, seq: 0, open: [summary, { ...summary, state: { kind: "sent", answer, delivery: "delivered" } }], closed: [] })
  && !out("prompts", { runtime, seq: 0, open: [], closed: [summary] })
  && !out("prompts", { runtime, seq: 0, open: [closedSummary], closed: [] }));
check("prompt returns a prompt only while it is open or sent",
  out("prompt", { prompt: { ...prompt, state: { kind: "sent", answer, delivery: "unconfirmed" } } })
  && !out("prompt", { prompt: { ...prompt, state: closedSummary.state } }));
check("prompts: runtime is the id and startedAt of the presence runtime value, with no source",
  !out("prompts", { runtime: { ...runtime, source: "endpoint-process" }, seq: 0, open: [], closed: [] }));
check("prompts takes {} and refuses null", AGENT_CONTRACTS.prompts.input.validate({}) && !AGENT_CONTRACTS.prompts.input.validate(null));
check("prompt-answer input: note up to 2000 characters, values of primitives and string lists",
  AGENT_CONTRACTS["prompt-answer"].input.validate({ id: prompt.id, digest: prompt.digest, option: "deny", note: "n".repeat(2000), values: { a: "x", b: 1, c: true, d: ["x"] } })
  && !AGENT_CONTRACTS["prompt-answer"].input.validate({ id: prompt.id, digest: prompt.digest, option: "deny", note: "n".repeat(2001) })
  && !AGENT_CONTRACTS["prompt-answer"].input.validate({ id: prompt.id, digest: prompt.digest, option: "deny", values: { a: { nested: 1 } } }));

// ── the envelope agreement branch (SPEC 13.21; cells 9 and 21) ──
const preq = parsed as ParsedEpPrincipalRequest;
const envOf = (over: Record<string, unknown> = {}): EndpointRequest => parseEndpointRequest({
  v: 1, id: "req1", op: { endpoint: "agent", command: "prompt-answer", inputDigest: D, outputDigest: D }, class: "ephemeral",
  replyExpected: true, deadlineMs: 15000, args: {}, from: { id: "u_alice.web", name: "web" }, ...over,
});
check("a well-formed principal request agrees with its subject", (() => { checkRequestSubjectAgreement(envOf(), preq); return true; })());
refusedWith("cell 9: from.id naming someone else is sender-mismatch", () => checkRequestSubjectAgreement(envOf({ from: { id: "u_alice.boss", name: "boss" } }), preq), "sender-mismatch");
refusedWith("cell 21: a body target is target-mismatch", () => checkRequestSubjectAgreement(envOf({ target: { owner: "u_alice", actor: "coder", lifecycleUid: UID } }), preq), "target-mismatch");
refusedWith("cell 21: a bind is bad-request", () => checkRequestSubjectAgreement(envOf({ bind: { instanceId: UID, epoch: 0 } }), preq), "bad-request");
refusedWith("op.command that disagrees with the subject is op-mismatch", () => checkRequestSubjectAgreement(envOf({ op: { endpoint: "agent", command: "prompts", inputDigest: D, outputDigest: D } }), preq), "op-mismatch");
refusedWith("op.endpoint that disagrees with the subject is op-mismatch", () => checkRequestSubjectAgreement(envOf({ op: { endpoint: "manager", command: "prompt-answer", inputDigest: D, outputDigest: D } }), preq), "op-mismatch");
refusedWith("a request with no deadline is bad-request on this route", () => checkRequestSubjectAgreement(envOf({ replyExpected: false, deadlineMs: undefined }), preq), "bad-request");
refusedWith("digests stay required on every command but describe", () => envOf({ op: { endpoint: "agent", command: "prompt-answer" } }), "contract-mismatch");

// ── serve-side construction (cell 23): the function validates before it touches a connection ──
const noConn = null as never;
const handlers = (["prompts", "prompt", "prompt-answer"] as const).map((command) => ({ command, contract: AGENT_CONTRACTS[command], handler: () => undefined }));
const plain = buildClusterDocument("ai.cotal.test", 1, [{ name: "prompts", targeted: false, capability: "agent.prompts.read", input: AGENT_COMMANDS[0].input, output: AGENT_COMMANDS[0].output }]);
throws("cell 23: a cluster command without authorities is never served on the principal route",
  () => servePrincipalRoute(noConn, SPACE, agent, { endpoint: AGENT_ENDPOINT, cluster: plain, handlers: [handlers[0]] }), "declares no authorities");
throws("a def for a command the cluster lacks is refused", () => servePrincipalRoute(noConn, SPACE, agent, { endpoint: AGENT_ENDPOINT, cluster: AGENT_CLUSTER, handlers: [...handlers, { ...handlers[0], command: "interrupt" }] }), "not in the cluster");
throws("a declared command without a def is refused", () => servePrincipalRoute(noConn, SPACE, agent, { endpoint: AGENT_ENDPOINT, cluster: AGENT_CLUSTER, handlers: handlers.slice(0, 2) }), "has no def");
throws("a custom describe def is refused", () => servePrincipalRoute(noConn, SPACE, agent, { endpoint: AGENT_ENDPOINT, cluster: AGENT_CLUSTER, handlers: [...handlers, { ...handlers[0], command: "describe" }] }), "reserved");
throws("compiled contracts that differ from the declared digests are refused",
  () => servePrincipalRoute(noConn, SPACE, agent, { endpoint: AGENT_ENDPOINT, cluster: AGENT_CLUSTER, handlers: [{ ...handlers[0], contract: AGENT_CONTRACTS.prompt }, handlers[1], handlers[2]] }), "do not equal");
throws("a structural contract without compile provenance is refused",
  () => servePrincipalRoute(noConn, SPACE, agent, { endpoint: AGENT_ENDPOINT, cluster: AGENT_CLUSTER, handlers: [{ ...handlers[0], contract: { input: { ...AGENT_CONTRACTS.prompts.input }, output: AGENT_CONTRACTS.prompts.output } }, handlers[1], handlers[2]] }), "profile-compiled");
const guardedDoc = { ...structuredClone(AGENT_CLUSTER), commands: AGENT_CLUSTER.commands.map((c, i) => (i === 0 ? { ...c, traits: ["ai.cotal.guarded"] } : c)) };
throws("a governed trait is refused: the route has no governed gate", () => servePrincipalRoute(noConn, SPACE, agent, { endpoint: AGENT_ENDPOINT, cluster: guardedDoc, handlers }), "governed");

// ── the rows (SPEC 13.21) ──
const self: EpCaller = { owner: "u_alice", actor: "coder", uid: UID };
const serve = epPrincipalServeGrantRows(SPACE, self);
check("serve rows: subscribe its own head for every runtime, publish replies under that head only",
  serve.sub.join("|") === `${P}.ep.prin.agent.u_alice.coder.${UID}.*.*.*.*.*.*.*` && serve.pub.join("|") === `${P}.ep.prin-reply.agent.u_alice.coder.${UID}.*.*.*.*.*`, serve);
check("the serve subscribe row has the request's 15 tokens and the reply row the reply's 13",
  serve.sub[0].split(".").length === 15 && serve.pub[0].split(".").length === 13);
const own = epPrincipalOwnerGrantRows(SPACE, web);
check("owner rows: describe, prompts, prompt, prompt-answer, commands and command, the caller's own owner pinned in the head",
  own.pub.join("|") === ["describe", "prompts", "prompt", "prompt-answer", "commands", "command"].map((cmd) => `${P}.ep.prin.agent.u_alice.*.*.*.${cmd}.owner.u_alice.web.${CUID}.*`).join("|"), own.pub);
check("owner rows: one reply read with the caller triple pinned", own.sub.join("|") === `${P}.ep.prin-reply.*.*.*.*.*.u_alice.web.${CUID}.*`);
const grantee: EpCaller = { owner: "u_bob", actor: "builder", uid: UID2 };
const grant = epPrincipalGrantRows(SPACE, grantee, { owner: "u_alice", actor: "coder", uid: UID }, ["prompts", "prompt-answer"]);
check("grant rows: the target principal and lifecycle literal, the runtime spanned, per command",
  grant.pub.join("|") === `${P}.ep.prin.agent.u_alice.coder.${UID}.*.prompts.grant.u_bob.builder.${UID2}.*|${P}.ep.prin.agent.u_alice.coder.${UID}.*.prompt-answer.grant.u_bob.builder.${UID2}.*`
  && grant.sub.join("|") === `${P}.ep.prin-reply.*.*.*.*.*.u_bob.builder.${UID2}.*`, grant);
check("no caller row puts * in the command position: rows are per command", [...own.pub, ...grant.pub].every((r) => r.split(".")[9] !== "*"));
throws("a grant row whose target is the grantee's own principal is refused (R4)", () => epPrincipalGrantRows(SPACE, grantee, { owner: "u_bob", actor: "builder", uid: UID }, ["prompts"]), "own prompt");
throws("a grant row never has a wildcard in the target's principal or lifecycle", () => epPrincipalGrantRows(SPACE, grantee, { owner: "u_alice", actor: "*", uid: UID }, ["prompts"]));
throws("a grant row's target lifecycle is a lifecycle UID, never _nr", () => epPrincipalGrantRows(SPACE, grantee, { owner: "u_alice", actor: "coder", uid: "_nr" }, ["prompts"]));
throws("a grant names only commands the cluster admits with grant", () => epPrincipalGrantRows(SPACE, grantee, { owner: "u_alice", actor: "coder", uid: UID }, ["interrupt"]), "admits");
throws("no grant row runs a command: command admits owner only", () => epPrincipalGrantRows(SPACE, grantee, { owner: "u_alice", actor: "coder", uid: UID }, ["command"]), "admits");
throws("no grant row lists commands: commands admits owner only", () => epPrincipalGrantRows(SPACE, grantee, { owner: "u_alice", actor: "coder", uid: UID }, ["commands"]), "admits");
check("the (command, word) pairs come from the cluster constant", principalRouteCommands("owner").join() === "describe,prompts,prompt,prompt-answer,commands,command"
  && principalRouteCommands("grant").join() === "describe,prompts,prompt,prompt-answer" && Object.isFrozen(principalRouteCommands("owner")));

// ── the two mint arms: which mints get which rows (SPEC 13.21) ──
const prinRows = (perms: Record<string, unknown>) => {
  const p = perms as { pub?: { allow?: string[] }; sub?: { allow?: string[] } };
  return [...(p.pub?.allow ?? []), ...(p.sub?.allow ?? [])].filter((r) => r.includes(".ep.prin"));
};
const callout = { owner: "u_alice", actor: "web", connId: "ibx0123456789abcdef0123456789abcd", readerId: "rdr0123456789abcd" };
/** `readerId: null` mints as a static mint does, with no reader id. */
const mint = (pr: { owner: string; actor: string }, opts: Record<string, unknown> = {}, uid = mintLifecycleUid(), readerId: string | null = callout.readerId) =>
  permissionsFor("agent", SPACE, { ...pr, connId: callout.connId, lifecycleUid: uid, ...(readerId !== null ? { readerId } : {}) }, opts);
const managed = mint({ owner: "u_alice", actor: "coder" }, { ledgerKind: "managed-agent" }, UID);
check("a managed-agent ledger row gets the serve rows and no caller row",
  prinRows(managed).sort().join("|") === [...serve.pub, ...serve.sub].sort().join("|"), prinRows(managed));
const interactive = mint({ owner: "u_alice", actor: "web" }, { ledgerKind: "interactive" }, CUID);
const webServe = epPrincipalServeGrantRows(SPACE, web);
check("an interactive ledger row gets the serve rows, the six owner rows and the reply read",
  prinRows(interactive).sort().join("|") === [...webServe.pub, ...webServe.sub, ...own.pub, ...own.sub].sort().join("|"), prinRows(interactive));
check("an interactive row's owner rows cover its own actor as a target, so the command must refuse a self-answer (R4)",
  (interactive as { pub: { allow: string[] } }).pub.allow.includes(`${P}.ep.prin.agent.u_alice.*.*.*.prompt-answer.owner.u_alice.web.${CUID}.*`));
check("a callout mint with no ledger kind (a chat session) gets none", prinRows(mint({ owner: "u_alice", actor: "chat" })).length === 0);
throws("a static mint carries no ledger kind", () => mint({ owner: "u_alice", actor: "coder" }, { ledgerKind: "interactive" }, UID, null), "static mint");
throws("an unknown ledger kind is refused", () => mint({ owner: "u_alice", actor: "coder" }, { ledgerKind: "admin" }, UID), "ledgerKind");
check("a static agent mint gets none", prinRows(mint({ owner: "local", actor: "coder" }, {}, UID, null)).length === 0);
const profiles: [string, () => Record<string, unknown>][] = [
  ["observer", () => permissionsFor("observer", SPACE, { owner: "u_alice", actor: "obs", connId: callout.connId, readerId: callout.readerId }, {})],
  ["admin", () => permissionsFor("admin", SPACE, { owner: "u_alice", actor: "console", connId: callout.connId, readerId: callout.readerId }, {})],
  ["delivery", () => permissionsFor("delivery", SPACE, { owner: "local", actor: "delivery", connId: callout.connId }, {})],
  ["supervisor", () => permissionsFor("supervisor", SPACE, { owner: "local", actor: "sup", connId: callout.connId }, {})],
  ["operator", () => permissionsFor("operator", SPACE, { owner: "local", actor: "op", connId: callout.connId }, {})],
  ["manager-caller", () => permissionsFor("manager-caller", SPACE, { owner: "u_alice", actor: "ops", connId: callout.connId, lifecycleUid: CUID, readerId: callout.readerId }, { capabilities: ["spawn", "admin"], lifecycleUid: CUID, managerInstanceId: UID2 })],
  ["control-caller-admin", () => permissionsFor("control-caller-admin", SPACE, { owner: "local", actor: "ctl", connId: callout.connId, lifecycleUid: CUID }, {})],
  ["deployer", () => permissionsFor("deployer", SPACE, { owner: "local", actor: "dep", connId: callout.connId, lifecycleUid: CUID }, {})],
  ["dm-reader", () => permissionsFor("dm-reader", SPACE, { owner: "u_alice", actor: "coder", connId: callout.connId, lifecycleUid: UID, readerId: callout.readerId }, {})],
  ["service serve rows", () => { const r = epServeGrantRows(SPACE, { endpoint: "org.example.svc", instanceId: UID2, epoch: 1, ephemeralCommands: ["run"] }); return { pub: { allow: r.pub }, sub: { allow: r.sub } }; }],
];
const holders: string[] = [];
for (const [name, build] of profiles) {
  let perms: Record<string, unknown>;
  try { perms = build(); } catch (e) { holders.push(`${name}: ${(e as Error).message}`); continue; }
  if (prinRows(perms).length > 0) holders.push(name);
}
check(`no view, infrastructure profile or service credential holds a principal-route row (${profiles.length} checked)`, holders.length === 0, holders);
throws("ledgerKind on any other profile is refused", () => permissionsFor("observer", SPACE, { owner: "u_alice", actor: "obs", connId: callout.connId, readerId: callout.readerId }, { ledgerKind: "interactive" }), "agent-profile");

// ── the maximum-capability credential (SPEC 13.9 fixture) with the new rows ──
// The fixture as SPEC 13.9 defines it: every baseline grant plus capabilities on 3 endpoints x 12
// commands each, each in both self and owner modes, journaled, with the per-goal read scopes (the
// goal-bearing commands `spawn` and `launch` on each endpoint), at concrete maximum-length tokens.
const OWNER = `u_${"a".repeat(26)}`, ACTOR = "x".repeat(64), MAXUID = "m".repeat(32);
const caps: EpCapability[] = [];
for (let e = 0; e < 3; e++)
  for (let k = 0; k < 12; k++)
    for (const target of [{ mode: "self" as const }, { mode: "owner" as const, tOwner: OWNER }])
      caps.push({ endpoint: `com.example${"e".repeat(40)}.ep${e}`, command: k === 0 ? "spawn" : k === 1 ? "launch" : `c${k}${"d".repeat(29)}`, target, journal: true });
const fixture = (ledgerKind?: "interactive") => permissionsFor("agent", SPACE, { owner: OWNER, actor: ACTOR, connId: callout.connId, lifecycleUid: MAXUID, readerId: callout.readerId },
  { endpointCapabilities: caps, ...(ledgerKind ? { ledgerKind } : {}) });
const account = createAccount();
const jwtBytes = async (perms: Record<string, unknown>) => Buffer.byteLength(await encodeUser(ACTOR, createUser(), account, perms as never, { exp: Math.floor(Date.now() / 1000) + 600 }), "utf8");
const without = await jwtBytes(fixture());
const withRows = await jwtBytes(fixture("interactive"));
console.log(`  maximum-capability fixture as an interactive mint: ${withRows} JWT bytes, ${withRows - without} of them the principal-route rows (mint bound ${MAX_MINTED_JWT_BYTES})`);
check("the maximum-capability fixture with the principal-route rows stays under the mint bound", withRows < MAX_MINTED_JWT_BYTES, { withRows, without, bound: MAX_MINTED_JWT_BYTES });
check("the interactive rows add 2 serve rows, 6 owner rows and 1 reply read", prinRows(fixture("interactive")).length - prinRows(fixture()).length === 9);

// ── the entry point: the package root serves the `agent` endpoint only ──
check("the package root does not export the general principal serve: CotalEndpoint.servePrincipal serves agent with AGENT_CLUSTER",
  !("servePrincipalRoute" in coreRoot) && typeof coreRoot.CotalEndpoint.prototype.servePrincipal === "function");

// ── the published schema: the presence `prompts` counts are non-negative integers (SPEC §6) ──
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/cotal.schema.json", import.meta.url)), "utf8")) as
  { definitions: Record<string, { properties: Record<string, { type?: string; minimum?: number }> }> };
const counts = schema.definitions.PresencePrompts?.properties;
check("spec/cotal.schema.json gives prompts.open and prompts.seq as non-negative integers",
  ["open", "seq"].every((k) => counts?.[k]?.type === "integer" && counts[k].minimum === 0), counts);

finish();
