/** Walk 2 of the validator, RESOLUTION: bind every identifier against the scope tree and check each
 *  effect call's shape, durations, once-effects and const writes. `validate` in `grammar.ts` drives it. */
import {
  BUILTINS,
  FORBIDDEN_GLOBALS,
  HOLDABLE_KINDS,
  HOST_GLOBAL_HINTS,
  NOTIFY_BOUND,
  PRIMITIVES,
  PROMISE_NAMES,
  RESERVED_NAMES,
  STEP_NAME_RE,
} from "./primitives.js";
import { KEY_RESERVED_RE, scopeTraits } from "./keys.js";
import { DurationError, isDuration, parseDuration } from "./duration.js";
import {
  type AnyNode,
  asyncCallPositionOk,
  checkCapturedWrites,
  children,
  hoistBindings,
  hoistFunctions,
  isFunctionNode,
  isNode,
  patternNames,
  patternTargets,
  propertyKeyName,
  Scope,
  unawaitedCause,
  unawaitedFix,
  Validator,
} from "./grammar-shared.js";

const RESERVED = new Set(RESERVED_NAMES);

const HOST_GLOBALS = new Set(FORBIDDEN_GLOBALS);

/**
 * `to` addresses the escalated mint and nothing else, so accepting it elsewhere records an input
 * that decides nothing, which the hash table then has to classify for no reason.
 */
function checkEscalateTo(bag: AnyNode | undefined, v: Validator): void {
  if (bag === undefined || bag.type !== "ObjectExpression") return;
  const prop = (want: string): AnyNode | undefined =>
    ((bag.properties as AnyNode[]) ?? []).find((p) => {
      const k = p.key as AnyNode | undefined;
      return k !== undefined && (k.type === "Identifier" ? k.name === want : k.value === want);
    });
  const to = prop("to");
  if (to === undefined) return;
  const onExpiry = prop("onExpiry");
  const value = onExpiry?.value as AnyNode | undefined;
  if (value?.type === "Literal" && value.value === "escalate") return;
  v.fail(
    "L3044",
    to,
    "`to` only addresses an escalated checkpoint, and this one does not escalate.",
    'Set `onExpiry: "escalate"`, or drop `to`.',
    "checkpoint",
  );
}

/**
 * `waitUntil`'s three static refusals, each judged where the source SHOWS it.
 *
 * All three are worth catching before the run starts rather than an hour into a wait, which is the
 * whole argument for checking them here: a wait is the one effect whose mistakes are expensive to
 * discover late. Each is re-checked at the call for the computed case the source cannot show, the
 * same division `fanOut`'s key rule uses.
 */
function checkWaitUntil(args: AnyNode[], given: Map<string, AnyNode>, v: Validator): void {
  const probe = args[0];
  // A FUNCTION LITERAL is the case the source can judge. An identifier may hold one, and a call
  // may return one, so those are left for the call-time check rather than guessed at here.
  if (
    probe !== undefined &&
    probe.type !== "ArrowFunctionExpression" &&
    probe.type !== "FunctionExpression" &&
    probe.type !== "Identifier" &&
    probe.type !== "MemberExpression" &&
    probe.type !== "CallExpression"
  ) {
    v.fail(
      "L3045",
      probe,
      "`waitUntil` takes a probe: a function the runtime calls on its own cadence to observe something outside the run. This is a value, so it would be observed once and never again.",
      'Pass a function: waitUntil(() => checks(sha), { name: "checks", every: "1m", deadline: "1h" })',
      "waitUntil",
    );
  }

  const every = given.get("every");
  const deadline = given.get("deadline");
  const missing = [every === undefined ? "every" : null, deadline === undefined ? "deadline" : null].filter(
    (x): x is string => x !== null,
  );
  if (missing.length > 0 && args.length > 0) {
    v.fail(
      "L3046",
      args[1] ?? (args[0] as AnyNode),
      `This \`waitUntil\` does not say ${missing.map((m) => `\`${m}\``).join(" or ")}. Neither has a default: a default cadence would guess how expensive someone else's resource is to poll, and a default deadline is a run that waits forever.`,
      'Give both: { name: "checks", every: "1m", deadline: "1h" }',
      "waitUntil",
    );
  }

  // A cadence longer than the deadline observes once and then fails, which is never what anyone
  // means. Judged only on two literals, because that is when the source actually shows it.
  const literal = (p: AnyNode | undefined): string | undefined => {
    const value = p?.value as AnyNode | undefined;
    return value?.type === "Literal" && typeof value.value === "string" ? value.value : undefined;
  };
  const e = literal(every);
  const d = literal(deadline);
  // A ZERO CADENCE IS NOT A CADENCE. `parseDuration("0ms")` is a perfectly good 0, so a bare
  // `every > deadline` test lets it through, and what it describes is a wait that observes with no
  // pause between looks: a busy loop against somebody else's resource, appending an observation to
  // a durable journal on every turn of it. The whole reason `every` has no default is that the
  // runtime must not guess how expensive a resource is to poll, and accepting zero is that same
  // guess made by omission.
  if (e !== undefined && isDuration(e) && parseDuration(e) <= 0) {
    v.fail(
      "L3047",
      every as AnyNode,
      `This observes every ${e}, which is no pause at all: the wait would poll the resource as fast as the run can turn and journal an observation each time.`,
      "Give `every` a real interval, the slowest one that still notices in time.",
      "waitUntil",
    );
  } else if (e !== undefined && d !== undefined && isDuration(e) && isDuration(d) && parseDuration(e) > parseDuration(d)) {
    v.fail(
      "L3047",
      every as AnyNode,
      `This observes every ${e} but gives up after ${d}, so it would make one observation and then fail without ever looking again.`,
      `Shorten \`every\` below \`deadline\`, or use \`sleep("${d}")\` and a single check if one look is what you meant.`,
      "waitUntil",
    );
  }
}

/**
 * `notify`'s fact is a bounded decision record, not a message.
 *
 * This is the one place a program can push its own bytes toward another agent's context, so the
 * bound is what keeps "conversation is the data plane, the program is the control plane" true at
 * the one boundary where it is easiest to break. A literal fact is checked exactly; a computed
 * one is checked at the effect boundary by the same rules.
 */
function checkNotifyFact(fact: AnyNode | undefined, v: Validator): void {
  if (fact === undefined || fact.type !== "ObjectExpression") return; // computed: checked at run time

  const seen = new Map<string, AnyNode>();
  for (const p of (fact.properties as AnyNode[]) ?? []) {
    if (p.type !== "Property") continue;
    const key = p.key as AnyNode;
    const keyName =
      key.type === "Identifier"
        ? (key.name as string)
        : key.type === "Literal" && typeof key.value === "string"
          ? key.value
          : null;
    if (keyName !== null) seen.set(keyName, p);
  }

  for (const [key, prop] of seen) {
    if (key !== "decision" && key !== "outcome" && key !== "detail") {
      v.fail(
        "L3043",
        prop,
        `A notify fact carries \`decision\`, \`outcome\`, and an optional \`detail\`, and nothing else. \`${key}\` would be an unbounded channel from the program into another agent's context.`,
        "Move the information into `detail` as a short scalar, or leave it for the agent to read from the channel.",
        "notify",
      );
    }
  }

  for (const field of ["decision", "outcome"] as const) {
    const prop = seen.get(field);
    if (prop === undefined) {
      v.fail(
        "L3043",
        fact,
        `A notify fact needs a \`${field}\`.`,
        'Name the decision and its outcome as tokens: { decision: "build", outcome: "blocked" }',
        "notify",
      );
      continue;
    }
    const value = prop.value as AnyNode;
    if (value.type !== "Literal" || typeof value.value !== "string") continue; // computed
    if (!NOTIFY_BOUND.tokenRe.test(value.value)) {
      v.fail(
        "L3043",
        value,
        `\`${field}\` names a decision, so it is a token rather than prose. "${value.value}" is not one.`,
        'Use kebab-case, 1 to 64 characters: { decision: "approve-plan", outcome: "auto-proceeded" }',
        "notify",
      );
    }
  }

  const detail = seen.get("detail");
  if (detail === undefined) return;
  const value = detail.value as AnyNode;
  if (value.type !== "ObjectExpression") {
    v.fail(
      "L3043",
      value,
      "`detail` is a record of short scalars.",
      "Use `{ attempts: 3 }` rather than a value of another shape.",
      "notify",
    );
    return;
  }

  const props = (value.properties as AnyNode[]) ?? [];
  if (props.length > NOTIFY_BOUND.maxDetailKeys) {
    v.fail(
      "L3043",
      value,
      `\`detail\` carries at most ${NOTIFY_BOUND.maxDetailKeys} keys; this one has ${props.length}. The cap is what keeps a notice a decision rather than a message.`,
      "Keep the fields that name the decision and drop the rest.",
      "notify",
    );
  }

  for (const p of props) {
    if (p.type !== "Property") continue;
    const key = p.key as AnyNode;
    const keyName =
      key.type === "Identifier"
        ? (key.name as string)
        : key.type === "Literal" && typeof key.value === "string"
          ? key.value
          : null;
    if (keyName !== null && !NOTIFY_BOUND.detailKeyRe.test(keyName)) {
      v.fail(
        "L3043",
        key,
        `\`${keyName}\` is not a detail key; they are kebab-case tokens of at most 32 characters.`,
        "Rename it, for example `attempt-count`.",
        "notify",
      );
    }
    const dv = p.value as AnyNode;
    if (dv.type === "ObjectExpression" || dv.type === "ArrayExpression") {
      v.fail(
        "L3043",
        dv,
        "Detail values are scalars: a short string, a number, or a boolean. A nested structure is an unbounded pipe into another agent's context.",
        "Flatten it, or leave it for the agent to read from the channel.",
        "notify",
      );
    } else if (
      dv.type === "Literal" &&
      typeof dv.value === "string" &&
      dv.value.length > NOTIFY_BOUND.maxDetailStringLength
    ) {
      v.fail(
        "L3043",
        dv,
        `A detail string is at most ${NOTIFY_BOUND.maxDetailStringLength} characters; this one is ${dv.value.length}. Longer than that is prose, and prose belongs in the channel where the agent can answer it.`,
        "Shorten it to a label, or put the content on the run record.",
        "notify",
      );
    }
  }
}

/** Every `spawn` lexically inside `root` whose options carry a LITERAL `worktree` string, as
 *  [worktree, the value node] pairs. Computed worktrees are invisible here by design: they are
 *  the runtime guard's (L4008) to decide, where the value exists. */
function literalSpawnWorktrees(root: AnyNode): Array<[string, AnyNode]> {
  const out: Array<[string, AnyNode]> = [];
  const visit = (n: AnyNode): void => {
    if (
      n.type === "CallExpression" &&
      (n.callee as AnyNode | undefined)?.type === "Identifier" &&
      ((n.callee as AnyNode).name as string) === "spawn"
    ) {
      const opts = (n.arguments as AnyNode[] | undefined)?.[1];
      if (opts !== undefined && opts.type === "ObjectExpression") {
        for (const prop of opts.properties as AnyNode[]) {
          if (prop.type !== "Property" || (prop.computed as boolean)) continue;
          const key = prop.key as AnyNode;
          const keyName = key.type === "Identifier" ? (key.name as string) : key.type === "Literal" ? String(key.value) : undefined;
          if (keyName !== "worktree") continue;
          const value = prop.value as AnyNode;
          if (value.type === "Literal" && typeof value.value === "string") out.push([value.value, value]);
        }
      }
    }
    for (const child of children(n)) visit(child);
  };
  visit(root);
  return out;
}

/** True when every element of an array literal is a record literal with a string `id`. */
function arrayItemsCarryId(items: AnyNode): boolean {
  const els = (items.elements as (AnyNode | null)[]) ?? [];
  if (els.length === 0) return false;
  return els.every((el) => {
    if (el === null || el === undefined || el.type !== "ObjectExpression") return false;
    return ((el.properties as AnyNode[]) ?? []).some((p) => {
      if (p.type !== "Property") return false;
      const key = p.key as AnyNode;
      const name = key.type === "Identifier" ? (key.name as string) : key.value;
      const value = p.value as AnyNode;
      return name === "id" && value.type === "Literal" && typeof value.value === "string";
    });
  });
}

/** Where the language reads a duration (§4.6): an argument by its index, and option keys. */
const DURATION_ARGUMENT: Readonly<Record<string, number>> = Object.freeze({ sleep: 0, idle: 1, duration: 0 });

const DURATION_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  turn: ["deadline"], ask: ["deadline"], checkpoint: ["timeout"], wait: ["timeout"], waitUntil: ["every", "deadline"],
});

/**
 * A literal written where a duration goes must be one (L2034). The call refuses it with the same
 * text, but only once a run reaches it; a value computed at run time is checked only there. An
 * option written as `null` is the option left out, so it is not a literal duration.
 */
function checkDurations(node: AnyNode, name: string, v: Validator): void {
  const args = (node.arguments as AnyNode[]) ?? [];
  const at = DURATION_ARGUMENT[name];
  if (at !== undefined && args[at] !== undefined) checkDurationLiteral(args[at], name, v);
  const keys = DURATION_OPTIONS[name];
  const bag = keys === undefined ? undefined : args[PRIMITIVES[name]!.optionsAt];
  if (keys === undefined || bag?.type !== "ObjectExpression") return;
  for (const p of (bag.properties as AnyNode[]) ?? []) {
    const value = p.value as AnyNode | undefined;
    if (p.type !== "Property" || value === undefined || !keys.includes(propertyKeyName(p) ?? "")) continue;
    if (!(value.type === "Literal" && value.value === null)) checkDurationLiteral(value, name, v);
  }
}

function checkDurationLiteral(node: AnyNode, name: string, v: Validator): void {
  const argument = node.argument as AnyNode | undefined;
  const written =
    node.type === "Literal" ? { value: node.value }
    : node.type === "TemplateLiteral" && (node.expressions as AnyNode[]).length === 0
      ? { value: ((node.quasis as AnyNode[])[0]?.value as { cooked?: string } | undefined)?.cooked }
    : node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+") && argument?.type === "Literal" && typeof argument.value === "number"
      ? { value: node.operator === "-" ? -argument.value : argument.value }
    : undefined;
  if (written === undefined || isDuration(written.value)) return;
  v.fail("L2034", node, new DurationError(String(written.value)).message, 'Write a duration string here, such as "30s", "10m" or "4h".', name);
}

function checkCall(node: AnyNode, v: Validator, scope: Scope): void {
  const callee = node.callee;
  if (!isNode(callee) || callee.type !== "Identifier") return;
  const name = callee.name as string;
  checkDurations(node, name, v);
  const spec = PRIMITIVES[name];
  if (spec === undefined) {
    // L2013's other half: a USER function declared `async` (or a const bound to an async function
    // expression) is an effect the moment it is called, and holding its call in a binding is the
    // rule's own motivating example: `const pa = work(a); const pb = work(b);`.
    const fn = scope.lookupFn(name);
    const parent = v.parents.get(node) ?? null;
    if (fn !== undefined && fn.async === true && parent !== null && !asyncCallPositionOk(parent)) {
      v.fail("L2013", node, unawaitedCause(name), unawaitedFix(name));
    }
    return;
  }

  const args = (node.arguments as AnyNode[]) ?? [];

  // `checkpoint` takes its name positionally; every other primitive takes it in the option bag.
  if (name === "checkpoint") {
    const first = args[0];
    if (first === undefined || first.type !== "Literal" || typeof first.value !== "string") {
      v.fail(
        "L3013",
        first ?? node,
        "A checkpoint's name must be a string literal, because the flowchart, the linter, and the migration report all read it without running the program.",
        'Pass a literal: checkpoint("approve-plan", "Approve the plan?", { timeout: "10m" })',
        name,
      );
    } else if (!STEP_NAME_RE.test(first.value)) {
      v.fail(
        "L3014",
        first,
        `"${first.value}" is not a well-formed step name.`,
        "Use kebab-case, 1 to 64 characters: \"approve-plan\".",
        name,
      );
    }
  }

  // The option bag sits at a FIXED index per primitive. It is deliberately not "the last record
  // argument": `notify(agents, fact, opts)` and `checkpoint(name, prompt, opts)` both take a
  // record in an earlier position, and reading that as options would reject correct data.
  const bag = args[spec.optionsAt];
  const bagIsRecord = bag !== undefined && bag.type === "ObjectExpression";

  const given = new Map<string, AnyNode>();
  if (bagIsRecord) {
    for (const p of (bag.properties as AnyNode[]) ?? []) {
      if (p.type !== "Property") continue;
      const key = p.key as AnyNode;
      if (key.type === "Identifier") given.set(key.name as string, p);
      else if (key.type === "Literal" && typeof key.value === "string") given.set(key.value, p);
    }
  }

  // Closed bags: an unknown key answers with the full signature rather than being ignored.
  for (const [key, prop] of given) {
    if (!spec.options.includes(key)) {
      v.fail(
        "L3011",
        prop,
        `\`${name}\` has no option named \`${key}\`, and option bags are closed so a typo cannot be silently dropped.`,
        `Accepted keys: ${spec.options.join(", ")}.`,
        name,
      );
    }
  }

  // Step names: REQUIRED-ness and VALIDITY are separate questions and must not share one gate.
  //
  // Required-ness is a statement about the caller's obligation; validity is a statement about the
  // sink. `nameRequired` is false for 7 of the 13 primitives, so behind one gate a name supplied on
  // any of those reaches `stepKeyString` unchecked: the optional path, which is the one nobody
  // writes tests for, feeds the same durable journal key as the required one. A name containing the
  // characters the key grammar reserves forges structure: two different programs then print one
  // identical key, and with matching inputs the collision is entirely silent.
  if (name !== "checkpoint") {
    const prop = given.get("name");
    if (prop === undefined) {
      if (spec.nameRequired) {
        v.fail(
          "L3012",
          node,
          `Every \`${name}\` needs a name, because its journal entry is keyed by that name rather than by its position. Without one, a resumed run cannot tell this step from any other.`,
          `Add a kebab-case name literal: ${name}(..., { name: "..." })`,
          name,
        );
      }
    } else {
      const value = prop.value as AnyNode;
      const isLiteral = value.type === "Literal" && typeof value.value === "string";
      // L3013 stays gated on `nameRequired`. Widening it to every present name refused
      // `fanOut([...], async (lens) => sleep("1m", { name: lens }))` — naming a branch's step after
      // its item, which is idiomatic and is how a fan-out gets distinct keys at all. That is the
      // cost this restriction would have had, and it is too high for what it buys: the SHAPE check
      // below is what closes the forgery, and it does not need the name to be static.
      if (!isLiteral) {
        if (spec.nameRequired) {
          v.fail(
            "L3013",
            value,
            "A step name must be a string literal, because the flowchart, the linter, and the migration report all read it without running the program.",
            'Use a literal: { name: "build" }',
            name,
          );
        }
        // A COMPUTED name cannot be checked here at all, and it reaches the same journal key. The
        // refusal for that one lives at key construction, where the value exists — see keys.ts.
      } else if (!STEP_NAME_RE.test(value.value as string)) {
        v.fail(
          "L3014",
          value,
          `"${value.value}" is not a well-formed step name.`,
          'Use kebab-case, 1 to 64 characters: { name: "build" }',
          name,
        );
      }
    }
  }

  if (name === "notify") checkNotifyFact(args[1], v);
  if (name === "checkpoint") checkEscalateTo(bag, v);
  if (name === "waitUntil") checkWaitUntil(args, given, v);

  // fanOut needs a stable branch key, or items that carry one. Warn only when the source SHOWS
  // there are no ids: items carrying a string `id` supply the key by design, so warning on those
  // would flag correct code, and a computed list cannot be judged from here at all. The runtime
  // refuses the genuinely unkeyable case, which is where an unknown list gets decided.
  if (name === "fanOut" && !given.has("key")) {
    const items = args[0];
    if (items !== undefined && items.type === "ArrayExpression" && !arrayItemsCarryId(items)) {
      v.warn(
        "L3021",
        node,
        "These items carry no `id`, so this fan-out has no stable branch key, and a reordered or filtered list would silently reshuffle every journal key underneath it.",
        'Pass a key function: fanOut(items, fn, { name: "reviews", key: (i) => i.id })',
        name,
      );
    }
  }

  // Array-form concurrency branches are keyed by index (design doc 7.2). Legal, linted.
  if ((name === "parallel" || name === "race") && args.length > 0) {
    const branches = args[0];
    if (branches !== undefined && branches.type === "ArrayExpression") {
      v.warn(
        "L3023",
        branches,
        "Array branches are keyed by index, so inserting a branch shifts every later branch's journal namespace and re-runs its steps.",
        `Use the record form: ${name}({ lint: () => ..., tests: () => ... }, { name: "checks" })`,
        name,
      );
    }
  }

  // Two agents MUST NOT share a worktree concurrently (spec 6.5: L3022 statically, L4008 at the
  // runtime guard). This is the static half, judged where the source shows it: a LITERAL worktree
  // declared by spawns in two DIFFERENT branches of one concurrent scope is two agents in one
  // working tree, and a literal worktree inside a fanOut's per-item function is that same sharing
  // written once and run by every branch. Sequential reuse within one branch stays legal, and a
  // computed worktree is the runtime guard's to decide.
  //
  // The body is the argument just before the options bag, read from the table as the captured-write
  // check below reads it, so a new scope primitive is judged without being named here. A record or
  // array body is its branches. A function body runs once per branch only in a scope that assembles
  // branch outcomes; `once` and `conclave` run their one function once.
  const sharedBody = spec.scope === null ? undefined : args[spec.optionsAt - 1];
  const branchSet = sharedBody !== undefined && (sharedBody.type === "ObjectExpression" || sharedBody.type === "ArrayExpression");
  if (branchSet) {
    // A branch is a branch however it is spelled: a named function stands in for its body,
    // resolved the way `branchThunks` resolves it for the walk.
    const branchNodes = (sharedBody.type === "ObjectExpression"
      ? (sharedBody.properties as AnyNode[]).filter((prop) => prop.type === "Property").map((prop) => prop.value as AnyNode)
      : ((sharedBody.elements as (AnyNode | null)[]).filter((el): el is AnyNode => el !== null && isNode(el))))
      .map((branch) => resolveFunction(branch, v, scope) ?? branch);
    const holders = new Map<string, AnyNode>();
    for (const branch of branchNodes) {
      for (const [wt, site] of literalSpawnWorktrees(branch)) {
        const prior = holders.get(wt);
        if (prior !== undefined && prior !== branch) {
          v.fail(
            "L3022",
            site,
            `Two branches of this \`${name}\` spawn agents into the worktree "${wt}", which runs them in one working tree at the same time. Concurrent writes to one working tree is data loss.`,
            "Move one spawn out of the concurrent scope, or give it its own worktree.",
            name,
          );
        } else if (prior === undefined) {
          holders.set(wt, branch);
        }
      }
    }
  }
  if (!branchSet && sharedBody !== undefined && isNode(sharedBody) && spec.scope !== null && scopeTraits(spec.scope)?.assembles) {
    const fn = resolveFunction(sharedBody, v, scope) ?? sharedBody;
    for (const [wt, site] of literalSpawnWorktrees(fn)) {
      v.fail(
        "L3022",
        site,
        `Every branch of this \`${name}\` runs this function, so each one spawns an agent into the worktree "${wt}": two agents in one working tree at the same time. Concurrent writes to one working tree is data loss.`,
        "Derive the worktree from the item (each branch its own tree), or move the spawn out of the fan-out.",
        name,
      );
    }
  }

  // A record-form branch KEY becomes a path segment verbatim: `frameString` builds
  // `/kind:name#occ/b:${branch}` by concatenation and escapes nothing. So a key containing one of
  // the three characters the key grammar reserves forges structure — a single branch named
  // `a/parallel:inner#0/b:b` prints the identical key to a genuinely nested `a` → `inner` → `b`,
  // and the journal cannot tell the two locations apart. With different inputs that surfaces as a
  // spurious L5001 divergence for a program that never diverged; with matching inputs it is
  // SILENT, one durable row serving both, and a replay hands the second location the first's
  // recorded effect.
  //
  // Only the reserved characters are rejected, NOT the full step-name pattern: branch keys are
  // ordinary object keys and `{ runTests: ... }` is legitimate, so requiring kebab-case here would
  // refuse correct programs to fix a forgery that needs `/`, `#` or `:`. The restriction is the
  // narrowest one that closes it.
  //
  // `fanOut` is not here: its first argument is the items, and its branch keys are minted at run
  // time from `key` or each item's `id`, where `assertKeySafe` refuses a reserved character.
  if (name === "parallel" || name === "race") {
    const branches = args[0];
    if (branches !== undefined && branches.type === "ObjectExpression") {
      for (const prop of (branches.properties as AnyNode[]) ?? []) {
        const key = prop.key as AnyNode | undefined;
        if (key === undefined) continue;
        const text =
          key.type === "Identifier" ? (key.name as string)
          : key.type === "Literal" && typeof key.value === "string" ? key.value
          : undefined;
        if (text === undefined || !KEY_RESERVED_RE.test(text)) continue;
        v.fail(
          "L3025",
          key,
          `The branch key "${text}" contains a character the step-key grammar reserves (\`/\`, \`#\` or \`:\`). Branch keys are written into the journal key verbatim, so this one can spell a path that a genuinely nested scope also produces — and two different locations that share a key share a durable row, silently when their inputs match.`,
          "Use a branch key without `/`, `#` or `:`.",
          name,
        );
      }
    }
  }

  // L2032: a branch that WRITES a binding declared outside it.
  //
  // Freeze-on-share does not see this one, because nothing crosses an effect boundary: the branches
  // set a scalar in the enclosing scope. And the damage is silent. Live, the branches write in
  // COMPLETION order; on resume the journalled effects return instantly, so they write in LAUNCH
  // order, the binding ends up holding a different value, and the resumed run takes a path it never
  // recorded — with no divergence raised, because no effect's inputs changed.
  //
  // `once` and `conclave` have one body and nothing to race, and are here for another reason: a
  // settled one is replayed without entering its body, so a write from it happens on the live run
  // only.
  if (spec.scope !== null) {
    // One `seen` set per combinator call: two branches calling the same helper is one defect in
    // that helper, not two, and reporting it twice tells an author to fix one line twice.
    const seen = new Set<AnyNode>();
    // The body is the argument just before the options bag. Reading it from the table keeps a new
    // scope primitive from having its data walked in place of its body.
    const thunks = branchThunks(args[spec.optionsAt - 1], v, scope);
    for (const thunk of thunks) checkCapturedWrites(thunk, name, v, seen);
    if (spec.scope === "once") {
      const reached = new Set<AnyNode>();
      for (const thunk of thunks) checkOnceEffects(thunk, v, reached);
    }
  }
  // A probe and the functions in its options bag run one level deeper too, in each observation's
  // own frame, and a settled `waitUntil` is replayed without calling them, so a write from one of
  // them happens on the live run only, as from a `once` body.
  if (spec.probeAt !== undefined) {
    const seen = new Set<AnyNode>();
    const fns = [args[spec.probeAt], ...(spec.functionOptions ?? []).map((k) => given.get(k)?.value as AnyNode | undefined)];
    for (const fn of fns) {
      const body = fn === undefined ? undefined : resolveFunction(fn, v, scope);
      if (body !== undefined) checkCapturedWrites(body, name, v, seen);
    }
  }
}

/**
 * L2033: an effect `once` does not admit, called in its body or in a function the body calls by
 * name. Every step under `once` is at-most-once, and only an `ask` can be held on resume, so the run
 * refuses anything else with L4028 when it reaches it; this refuses the calls the validator can see
 * before the run starts. A primitive name is reserved, so a call by that name is the primitive.
 */
function checkOnceEffects(fn: AnyNode, v: Validator, seen: Set<AnyNode>): void {
  if (seen.has(fn)) return;
  seen.add(fn);
  const visit = (node: AnyNode): void => {
    const callee = node.type === "CallExpression" && isNode(node.callee) ? node.callee as AnyNode : undefined;
    if (callee?.type === "Identifier") {
      const name = callee.name as string;
      const kind = Object.hasOwn(PRIMITIVES, name) ? PRIMITIVES[name]!.kind : null;
      if (kind !== null && !HOLDABLE_KINDS.has(kind)) {
        v.fail(
          "L2033",
          node,
          `\`${name}\` runs inside \`once\`, and \`once\` admits only \`ask\`: a resume could not hold any other effect without performing it again or losing the run state it builds.`,
          `Move the \`${name}\` outside the \`once\`, so only the \`ask\` it guards stays inside.`,
          name,
        );
      } else {
        const target = v.functions.get(name);
        if (target !== undefined && target !== null) checkOnceEffects(target, v, seen);
      }
    }
    for (const c of children(node)) visit(c);
  };
  if (isNode(fn.body)) visit(fn.body as AnyNode);
}

/**
 * Resolve a branch to the function it names, or to nothing.
 *
 * A NAMED branch resolves through its lexical binding at the combinator call, never through the
 * program-wide name map: `async function use(branch) { await parallel({ branch }) }` passes its own
 * parameter, and resolving that name to a same-named top-level declaration made a clean program
 * unwriteable — L2032 blamed a write in a function the program never even called. A name bound to
 * something that is not a function is UNPROVEN, and unproven is the interpreter's depth check to
 * refuse at runtime, not the validator's to guess at.
 */
function resolveFunction(node: AnyNode, v: Validator, scope: Scope): AnyNode | undefined {
  if (isFunctionNode(node)) return node;
  if (node.type !== "Identifier") return undefined;
  const name = node.name as string;
  // Bound here: the binding answers, whatever it is bound to. Unbound: walk 2 has already raised
  // L2001 for it, so the module index is the fallback.
  if (scope.lookup(name) !== undefined) return scope.lookupFn(name);
  return v.functions.get(name) ?? undefined;
}

/**
 * The thunks a combinator owns, in every form the language accepts.
 *
 * `parallel({ a: () => …, b })` mixes an inline branch and a NAMED one, and a first version of this
 * dropped the named half — so a captured-write program written with two named
 * `async function`s instead of two arrows, was accepted. A branch is a branch however it is
 * spelled.
 */
function branchThunks(node: AnyNode | undefined, v: Validator, scope: Scope): AnyNode[] {
  if (node === undefined) return [];
  const one = resolveFunction(node, v, scope);
  if (one !== undefined) return [one];
  const out: AnyNode[] = [];
  if (node.type === "ObjectExpression") {
    for (const p of (node.properties as AnyNode[]) ?? []) {
      if (p.type !== "Property" || !isNode(p.value)) continue;
      const fn = resolveFunction(p.value as AnyNode, v, scope);
      if (fn !== undefined) out.push(fn);
    }
  }
  if (node.type === "ArrayExpression") {
    for (const el of (node.elements as (AnyNode | null)[]) ?? []) {
      if (el === null || !isNode(el)) continue;
      const fn = resolveFunction(el, v, scope);
      if (fn !== undefined) out.push(fn);
    }
  }
  return out;
}

export function walkResolve(node: AnyNode, v: Validator, scope: Scope): void {
  switch (node.type) {
    case "Identifier": {
      const name = node.name as string;
      if (scope.refersToPending(name)) {
        v.fail(
          "L2004",
          node,
          `\`${name}\` is declared later in this block, and a \`let\` or \`const\` binds the whole block: executed, this line would find a binding that holds no value yet (JavaScript's temporal dead zone, a guaranteed runtime error in straight-line code).`,
          "Move the declaration above its first use, or rename one of the two.",
        );
        return;
      }
      if (scope.lookup(name) !== undefined) return;
      if (RESERVED.has(name)) return;
      if (PROMISE_NAMES.has(name)) {
        v.fail(
          "L2011",
          node,
          "Promises are not in the language, so concurrency is always visible in the source and therefore in the journal and the flowchart.",
          "Use `parallel`, `race`, or `fanOut`.",
        );
        return;
      }
      if (HOST_GLOBALS.has(name)) {
        v.fail(
          "L2012",
          node,
          `\`${name}\` is a host global. There is no ambient IO, clock, or randomness here: the interpreter has nothing nondeterministic to offer.`,
          HOST_GLOBAL_HINTS[name] ??
            "Use `now()` for time, `random()` for randomness, `sleep()` to wait, and `log()` for output.",
        );
        return;
      }
      v.fail(
        "L2001",
        node,
        `\`${name}\` is not defined anywhere in this program. Every name resolves when the program is read, so this is never a runtime surprise.`,
        `Define it, or check the spelling. The builtins are: ${BUILTINS.join(", ")}.`,
      );
      return;
    }

    case "VariableDeclaration": {
      const kind = node.kind === "const" ? "const" : "let";
      for (const d of (node.declarations as AnyNode[]) ?? []) {
        const init = d.init;
        if (isNode(init)) walkResolve(init, v, scope);
        const names: string[] = [];
        patternNames(d.id as AnyNode, names);
        // `const b = async () => {...}` binds a FUNCTION, and a branch named `b` must resolve to
        // it. Only the plain `id = function` form does: a destructured name holds whatever the
        // pattern pulled out, which is not statically a function.
        const bound =
          isNode(d.id) && (d.id as AnyNode).type === "Identifier" && isNode(init) && isFunctionNode(init as AnyNode)
            ? (init as AnyNode)
            : undefined;
        for (const n of names) {
          if (RESERVED.has(n)) {
            v.fail(
              "L2002",
              d.id as AnyNode,
              `\`${n}\` is a builtin, so shadowing it would make a call to \`${n}\` mean two different things in one program.`,
              `Rename the binding, for example \`${n}Result\`.`,
            );
          }
          scope.declare(n, kind, bound);
          scope.pending.delete(n);
        }
      }
      return;
    }

    case "AssignmentExpression": {
      checkConstWrite(node.left as AnyNode, scope, v);
      for (const c of children(node)) walkResolve(c, v, scope);
      return;
    }

    case "MemberExpression": {
      // Only the object side is a name; a non-computed property is a field, not a binding.
      const object = node.object;
      if (isNode(object)) walkResolve(object, v, scope);
      if (node.computed === true && isNode(node.property)) walkResolve(node.property as AnyNode, v, scope);
      return;
    }

    case "Property": {
      // Shorthand `{ x }` reads `x`; a non-computed key is a field name, not a binding.
      if (node.computed === true && isNode(node.key)) walkResolve(node.key as AnyNode, v, scope);
      if (isNode(node.value)) walkResolve(node.value as AnyNode, v, scope);
      return;
    }

    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      if (node.type === "FunctionDeclaration" && isNode(node.id)) {
        const fname = (node.id as AnyNode).name as string;
        if (RESERVED.has(fname)) {
          v.fail(
            "L2002",
            node.id as AnyNode,
            `\`${fname}\` is a builtin, so a function of that name would shadow it.`,
            "Rename the function.",
          );
        }
        scope.declare(fname, "const", node);
      }
      const inner = new Scope(scope);
      inner.fnBoundary = true;
      // A NAMED function expression binds its own name inside itself, which is how a function
      // assigned to a `const` recurses: `const f = function walk(n) { ... walk(n - 1) ... }`.
      if (node.type === "FunctionExpression" && isNode(node.id)) {
        const fname = (node.id as AnyNode).name as string;
        if (RESERVED.has(fname)) {
          v.fail(
            "L2002",
            node.id as AnyNode,
            `\`${fname}\` is a builtin, so a function expression of that name would shadow it inside itself.`,
            "Rename the function.",
          );
        }
        inner.declare(fname, "const", node);
      }
      // Parameters bind LEFT TO RIGHT, and a default sees only the parameters before it: every
      // name is pre-declared pending, and each parameter leaves the dead zone only after its own
      // default was walked, so `(a = b, b = 1)` and `(a = a)` are L2004 the way straight-line
      // block references are — JavaScript would throw the same at every call that evaluates the
      // default, and a default that cannot ever evaluate is a landmine, not a feature.
      const params = (node.params as AnyNode[]) ?? [];
      const paramNames: string[][] = params.map((p) => {
        const names: string[] = [];
        patternNames(p, names);
        return names;
      });
      for (let i = 0; i < params.length; i += 1) {
        const p = params[i] as AnyNode;
        for (const n of paramNames[i] as string[]) {
          if (RESERVED.has(n)) {
            v.fail(
              "L2002",
              p,
              `\`${n}\` is a builtin, so a parameter of that name would shadow it inside this function.`,
              "Rename the parameter.",
            );
          }
          inner.declare(n, "param");
          inner.pending.add(n);
        }
      }
      for (let i = 0; i < params.length; i += 1) {
        const p = params[i] as AnyNode;
        if (p.type === "AssignmentPattern" && isNode(p.right)) walkResolve(p.right as AnyNode, v, inner);
        for (const n of paramNames[i] as string[]) inner.pending.delete(n);
      }
      if (isNode(node.body)) walkResolve(node.body as AnyNode, v, inner);
      return;
    }

    case "BlockStatement": {
      const inner = new Scope(scope);
      hoistFunctions(node, inner);
      hoistBindings(node, inner);
      for (const s of (node.body as AnyNode[]) ?? []) walkResolve(s, v, inner);
      return;
    }

    case "CatchClause": {
      const inner = new Scope(scope);
      if (isNode(node.param)) {
        const names: string[] = [];
        patternNames(node.param as AnyNode, names);
        for (const n of names) inner.declare(n, "const");
      }
      if (isNode(node.body)) walkResolve(node.body as AnyNode, v, inner);
      return;
    }

    case "ForStatement":
    case "ForOfStatement": {
      // `for (x of xs)` with no declaration assigns `x` on every iteration.
      if (node.type === "ForOfStatement" && (node.left as AnyNode).type !== "VariableDeclaration") {
        checkConstWrite(node.left as AnyNode, scope, v);
      }
      const inner = new Scope(scope);
      for (const c of children(node)) walkResolve(c, v, inner);
      return;
    }

    case "CallExpression": {
      checkCall(node, v, scope);
      for (const c of children(node)) walkResolve(c, v, scope);
      return;
    }

    default: {
      for (const c of children(node)) walkResolve(c, v, scope);
      return;
    }
  }
}

/** A destructuring leaf writes its binding as surely as a bare `x = …` does. */
function checkConstWrite(target: AnyNode, scope: Scope, v: Validator): void {
  const targets: AnyNode[] = [];
  patternTargets(target, targets);
  for (const t of targets) {
    if (t.type === "Identifier" && scope.lookup(t.name as string) === "const") {
      v.fail(
        "L2003",
        t,
        `\`${t.name as string}\` is declared \`const\`.`,
        "Declare it with `let` if it is meant to be reassigned.",
      );
    }
  }
}
