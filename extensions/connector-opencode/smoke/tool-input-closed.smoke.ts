/**
 * OPENCODE ADVERTISES OPEN AND ENFORCES CLOSED, AND BOTH HALVES OF THAT ARE MEASURED, NOT CHOSEN.
 *
 * The shared specs carry a CLOSED input object so an unmodelled key — `owner`, `actor` — is refused
 * by name instead of silently stripped. On the MCP hosts and pi the host itself refuses one and the
 * tool is never reached. OpenCode is neither of those things, in two ways that pull in opposite
 * directions:
 *
 *   ADVERTISE. Its `args` is a raw SHAPE at runtime, not a schema. Handed the closed object it
 *   walks that OBJECT's own properties as if they were the field map, and the whole `tool.list`
 *   response then fails to serialize — every cotal_* tool disappears from the session, not just the
 *   one. So the adapter renders `spec.schema.shape`, and what OpenCode publishes stays open.
 *
 *   ENFORCE. It does NOT validate before calling us. Its plugin type says `execute(args:
 *   z.infer<z.ZodObject<Args>>)`, but a real call through a real OpenCode session delivered
 *   `{text, owner, actor}` to `execute` intact. Nothing above the adapter has touched those args,
 *   so the adapter's own dispatch is the boundary — closing there is the genuine enforcement point,
 *   not a stand-in for one.
 *
 * The asymmetry is the cost of the host and is worth stating: the model is not told up front that
 * the key is disallowed, it learns from the refusal at call time. That makes the refusal the whole
 * interface, so it names the rejected keys AND lists what the tool does accept — enough for the
 * next attempt to be right without a second guess.
 *
 * WHAT THIS FILE ASSERTS:
 *   1. the rendered `args` is a raw shape, NOT the closed object   <- or the tool list 400s
 *   2. a call carrying identity-shaped extras is REFUSED
 *   3. the refusal names the rejected keys and the accepted ones
 *   4. ...and the tool's `run` never executes
 *
 * WHAT IT DOES NOT COVER: that OpenCode still passes args through unvalidated. That is the host's
 * behaviour, not ours, and if a future OpenCode starts stripping, (2)-(4) keep passing while the
 * key is dropped upstream — the assertions here would then be measuring our parse against args the
 * host already cleaned. Re-measure through a live session before relying on this as host coverage.
 *
 * Run: pnpm smoke:opencode-tool-closed
 */
import { configFromEnv, cotalToolSpecs, type MeshAgent } from "@cotal-ai/connector-core";
import { buildCotalTools } from "../src/tools.js";

process.env.COTAL_SPACE ||= "toolclosed";
process.env.COTAL_NAME ||= "oc-1";
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { console.log(`  ok    ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

const config = configFromEnv();
// Any use of the agent means the refusal did not bite: fail loudly rather than let a mutated
// fixture pass quietly.
const agent = new Proxy({} as MeshAgent, {
  get(_t, prop) { throw new Error(`the tool reached the mesh agent (${String(prop)}) — it should have been refused`); },
});

const TOOL = "cotal_status"; // takes only optional args, so the extras are the ONLY reason to fail
const spec = cotalToolSpecs(config, "opencode").find((s) => s.name === TOOL);
if (!spec?.schema) throw new Error(`${TOOL} is no longer a schema-bearing tool — repoint this suite`);
const accepted = Object.keys(spec.schema.shape);

const tools = buildCotalTools(agent, config);
const tool = tools[TOOL];
check(`${TOOL} is rendered onto the OpenCode surface`, !!tool);

// 1. A raw shape, not the closed object. `safeParse` is the discriminator: the closed object has
// it, a field map does not — and handing OpenCode the object with it is what breaks tool.list.
const args = tool.args as unknown as Record<string, unknown> & { safeParse?: unknown };
check("the rendered args is a raw SHAPE, not the closed object OpenCode cannot serialize",
  typeof args?.safeParse !== "function" && Object.keys(args ?? {}).length === accepted.length,
  { keys: Object.keys(args ?? {}), accepted });

// EVERY dispatch call in this file goes through here, and none of them awaits `execute` bare.
// The agent proxy throws on any access, so a refusal that stops biting does not produce a wrong
// answer — it produces an uncaught exception that aborts the file at the call site, BEFORE the
// assertion grading that call can print. The suite is red either way and the exit code is the
// same, so a regression can be credited as a kill without the refusal ever being proved. Turning
// the throw into a value is what makes each cell report on its own line.
const dispatch = async (name: string, args: Record<string, unknown>): Promise<string> => {
  try {
    return String(await tools[name].execute(args, {} as never));
  } catch (e) {
    return `threw: ${(e as Error).message}`;
  }
};

// 2-4. The dispatch closes what the host left open.
const IDENTITY_EXTRA = { owner: "u_attacker", actor: "someone-else" };
const out = await dispatch(TOOL, { ...IDENTITY_EXTRA });

check("a call carrying identity-shaped extras is REFUSED at the adapter's dispatch",
  out.startsWith("⚠"), { out });
check("the refusal names the rejected keys AND lists what the tool accepts",
  Object.keys(IDENTITY_EXTRA).every((k) => out.includes(k)) && accepted.every((k) => out.includes(k)),
  { out, accepted });
// The agent Proxy throws on any access, so a reached `run` would have surfaced as a thrown error
// rather than a refusal string — which is precisely what the assertion above would have caught.
check("...and the refusal precedes the effect: the tool never reached the mesh agent",
  !out.includes("reached the mesh agent"), { out });

// 5-6. The ZERO-ARGUMENT tools, which travel a different path and were the hole: one rendered
// straight from an empty shape, and `cotal_inbox`, whose args this adapter REPLACES with its own
// scope. Replacing the caller's object is correct; ignoring it is not — an extra key would have
// been swallowed by the substitution on that tool alone.
const ZERO = "cotal_roster";
const zeroSpec = cotalToolSpecs(config, "opencode").find((s) => s.name === ZERO);
if (!zeroSpec || Object.keys(zeroSpec.schema.shape).length !== 0) throw new Error(`${ZERO} is no longer a zero-argument tool — repoint this suite`);
const zeroOut = await dispatch(ZERO, { ...IDENTITY_EXTRA });
check(`a ZERO-ARGUMENT tool (${ZERO}) is refused too, naming the keys and saying it takes none`,
  zeroOut.startsWith("⚠") && Object.keys(IDENTITY_EXTRA).every((k) => zeroOut.includes(k)) &&
    zeroOut.includes("no arguments") && !zeroOut.includes("reached the mesh agent"),
  { zeroOut });

const inboxOut = await dispatch("cotal_inbox", { ...IDENTITY_EXTRA });
check("cotal_inbox, whose args this adapter SUBSTITUTES, refuses the caller's extras rather than discarding them",
  inboxOut.startsWith("⚠") && Object.keys(IDENTITY_EXTRA).every((k) => inboxOut.includes(k)) &&
    !inboxOut.includes("reached the mesh agent"),
  { inboxOut });

console.log(`\n${failures === 0 ? "OPENCODE-TOOL-CLOSED SMOKE OK ✅" : "OPENCODE-TOOL-CLOSED SMOKE FAILED"}  (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
