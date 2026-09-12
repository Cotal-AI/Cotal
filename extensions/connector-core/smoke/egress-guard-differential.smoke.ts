/**
 * A replacement safety predicate graded against the predicate it replaced, on the same corpus.
 *
 * Every existing cell asks what the CURRENT function returns. None asks what the PREVIOUS function
 * returned for the same input, which is how three successive heads of the egress fence shipped a
 * classifier weaker than the one they replaced and no check named any of them. This file is that
 * check, for any pair of refs, over the frozen-body egress predicate in
 * `extensions/connector-core/src/agui.ts`.
 *
 * ROLE, NOT NAME. The export has already renamed and re-shaped once:
 * `frozenBodyViolatesEgressPolicy` (boolean) became `frozenBodyEgressVerdict` (three-way). A
 * harness pinned to one identifier is the next rename's first casualty. The loader reads that
 * file BY PATH at each ref and binds whichever exported function occupies the frozen-body
 * classifier ROLE. A boolean arm answers ALLOW / REFUSE / THROW. A three-way arm answers
 * clean / forbidden-kind / unreadable, and a throw from a three-way is recorded as a throw,
 * never coerced into a boolean. The comparison that names WEAKER / STRICTER is the explicit
 * publish mapping recorded next to the loader, not a silent `if (x) refuse`.
 *
 * AXES 1-15 were derived from the origin/main read pattern BEFORE any 1429 lane artifact was
 * opened (commit 8ff8eb763). Everything after that line is append-only: ADOPTED / NOVEL / LANE
 * axes labelled as such, then the corpus, the loader, and the two grading pairs. The forbidden
 * set is derived behaviourally from applyAguiEgressPolicy over Object.values(AGUI_EVENT_TYPE)
 * from the #1429 acceptance harness; the three ADOPTED axes are also from #1429, rebuilt here
 * rather than copied.
 *
 * Follows `packages/lang/smoke/differential.smoke.ts`: CORPUS / DIVERGENT / HELD, both-direction
 * grading, and prose on what a zero does not prove. #1426 is the adjacent reachability gap;
 * this instrument does not close it. T-PARSE and T-READONCE already pin the envelope class and
 * the representation class on THIS sha; this file's value is cross-ref grading, which neither
 * of them does.
 *
 * WHAT A ZERO DOES NOT PROVE. A differential is blind to symmetric loss by construction: two
 * arms that flatten the same way compare equal. The comparator here is the publish mapping
 * (withhold vs publish), so two arms that withhold for different named reasons still compare
 * equal on WEAKER/STRICTER. Those named disagreements live in DIVERGENT, pinned to both
 * answers, so retiring one reds this suite instead of quietly passing. A zero is also
 * corpus-limited: it does not speak to an input that is not a row, to a WAL encoder this
 * suite never runs, or to whether a live entry point reaches the predicate (#1426).
 *
 * HISTORY. Smoke CI checks out depth 1 (`actions/checkout@v6` with no fetch-depth). A short
 * prefix `git show ee73e33c1:...` is `fatal: invalid object name` there even though the commit
 * is on origin. The loader pins 40-char SHAs, `git cat-file -e <sha>^{commit}`, and if the
 * object is missing `git fetch --no-tags --depth=1 origin <sha>`. Still missing is
 * `missing-history:`, never a silent bind of HEAD and never a vendored copy of the function.
 * The missing-history control proves that: a well-formed SHA that is not in the checkout, with
 * fetch disabled, must throw `missing-history:` rather than classify anything.
 *
 * Run: pnpm smoke:egress-guard-differential
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGUI_EVENT_TYPE,
  aguiFrame,
  applyAguiEgressPolicy,
  reasoningMessageContent,
  reasoningMessageEnd,
  reasoningMessageStart,
  runError,
  runFinished,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart,
  type AguiEvent,
} from "../src/agui.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const SRC_DIR = join(HERE, "..", "src");
const AGUI_PATH = "extensions/connector-core/src/agui.ts";

let pass = 0;
const failures: string[] = [];
const CELLS: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  CELLS.push(name);
  if (cond) {
    pass += 1;
    console.log(`  ok ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
};

/**
 * One axis is one READ the predicate actually performs, or one answer it can give. A corpus
 * that varies a field nobody reads is a green loop over nothing. A corpus that varies only the
 * field the last finding named is how the hole moved rather than closed.
 *
 * Derived from, in order: iterating `body`; `isAguiFramePart` (kind, never throws);
 * `parseAguiFrame` (protocol, threadId, runId, epoch, seq, events array, element type);
 * scanning `frame.events` for the forbidden set; the three-way vocabulary and the outer catch
 * that makes the `unknown[]` signature mean it. `parseAguiFrame` ends `return part as AguiFrame`
 * — a CAST, not a copy — so a later scan of `frame.events` re-reads the caller's object.
 */
export const ORIGINAL_AXES = [
  {
    id: "control",
    rationale:
      "A well-formed allowed frame and a well-formed forbidden frame must both reach the predicate in the same run; without them a green is indistinguishable from a corpus that never entered the function.",
  },
  {
    id: "envelope-protocol",
    rationale:
      "parseAguiFrame's first field check after routing; a predecessor that skipped the parse published a wrong-protocol frame.",
  },
  {
    id: "envelope-threadId",
    rationale: "parseAguiFrame requires threadId to be a non-empty string.",
  },
  {
    id: "envelope-runId",
    rationale: "parseAguiFrame requires runId to be a non-empty string.",
  },
  {
    id: "envelope-epoch",
    rationale: "parseAguiFrame requires epoch to be a non-empty string.",
  },
  {
    id: "envelope-seq",
    rationale:
      "parseAguiFrame requires seq to be a non-negative safe integer, so missing, negative, fractional, NaN and Infinity are distinct failures of that predicate.",
  },
  {
    id: "events-shape",
    rationale:
      "parseAguiFrame requires Array.isArray(events) && length > 0; missing, empty, string, object and null are the skip-vs-throw split that shipped at 1698fe253.",
  },
  {
    id: "event-element",
    rationale:
      "parseAguiFrame requires each element to be a non-null object whose type is a recognised AG-UI discriminator; null, number, string, missing type, unknown type and a nested smuggle are the element-level holes a list-level check cannot see.",
  },
  {
    id: "forbidden-kind",
    rationale:
      "The scan's positive: TOOL_CALL_ARGS and TOOL_CALL_RESULT on a well-formed frame must answer forbidden-kind (or boolean refuse), not unreadable and not clean.",
  },
  {
    id: "allowed-kind",
    rationale:
      "Sibling types the policy must still publish: text, tool start/end, run lifecycle, RUN_ERROR. A fail-closed catch can buy totality by refusing these.",
  },
  {
    id: "routing-kind",
    rationale:
      "isAguiFramePart inspects kind and nothing else; a wrong kind or a non-object part is skipped, which is the named non-frame gap this function neither widens nor closes.",
  },
  {
    id: "body-composition",
    rationale:
      "The predicate classifies a BODY, not a part: empty, mixed frame+junk, unreadable-then-forbidden, forbidden-then-unreadable. forbidden-kind wins across parts; an earlier unreadable must not hide a later forbidden event.",
  },
  {
    id: "iteration-totality",
    rationale:
      "The outer catch is the unknown[] signature meaning it: a Proxy whose Symbol.iterator traps, or an array with a throwing index accessor, raises before any per-part catch. JSON cannot produce these; they grade the exported signature.",
  },
  {
    id: "representation",
    rationale:
      "parseAguiFrame returns a cast, so the scan re-reads the caller's object. Own accessor, inherited accessor, and a Proxy whose getOwnPropertyDescriptor reports a data property while get is stateful are the class a snapshot read is weaker on.",
  },
  {
    id: "json-roundtrip",
    rationale:
      "A WAL body is JSON; a live constructor result and JSON.parse(JSON.stringify) of it must classify the same for every JSON-representable row, or the live object is grading a shape disk will never hold.",
  },
] as const;

/**
 * Append-only over ORIGINAL_AXES. Labels: ADOPTED (#1429 named the axis; we rebuilt the
 * fixture), NOVEL (only we named it), LANE (manager-supplied, not derived here).
 */
export const APPENDED_AXES = [
  {
    id: "same-part-ordering",
    origin: "ADOPTED",
    rationale:
      "#1429: one frame that both fails parse and carries a forbidden event. Across-parts is a different catch; parseAguiFrame runs before the scan, so within one part unreadable beats forbidden.",
  },
  {
    id: "event-type-throw",
    origin: "ADOPTED",
    rationale:
      "#1429: a throwing getter on events[i].type, inside an element the scan reads after parse.",
  },
  {
    id: "representation-flip",
    origin: "ADOPTED",
    rationale:
      "#1429: successive reads of events disagree: clean on reads 1..N and forbidden after. This is the axis that grades 'four reads in the same order', rebuilt over both forbidden types and the allowed set, not lifted as a TEXT-vs-RESULT shape.",
  },
  {
    id: "events-throw",
    origin: "NOVEL",
    rationale:
      "A throwing getter on the events property itself. Three events accessors in the 1429 instrument all RETURN a value; none of them THROWS. Iterator-throw, index-throw, and type-throw are other catch sites.",
  },
  {
    id: "frozen-ness",
    origin: "LANE",
    rationale:
      "Production hands the guard a WAL-frozen body. Object.freeze is a stand-in for that shape; neither prior corpus froze a body. Shallow freeze cannot grow properties; it is not the WAL encoder.",
  },
] as const;

export const AXES = [...ORIGINAL_AXES, ...APPENDED_AXES];
export type AxisId = (typeof AXES)[number]["id"];

type Raw =
  | { shape: "boolean"; value: "ALLOW" | "REFUSE" | "THROW"; detail?: string }
  | { shape: "three-way"; value: "clean" | "forbidden-kind" | "unreadable" | "THROW"; detail?: string };

/** Explicit publish mapping. Three-way is never folded into a boolean. */
const publishes = (raw: Raw): boolean => {
  if (raw.shape === "boolean") return raw.value === "ALLOW";
  return raw.value === "clean";
};

type Classify = (body: readonly unknown[]) => Raw;

interface Arm {
  readonly ref: string;
  readonly role: "boolean" | "three-way";
  readonly classify: Classify;
}

const bindRole = (mod: Record<string, unknown>, ref: string): Arm => {
  const three = mod.frozenBodyEgressVerdict;
  const bool = mod.frozenBodyViolatesEgressPolicy;
  if (typeof three === "function" && typeof bool === "function") {
    throw new Error(`${ref}: both classifier roles exported; the loader refuses to guess`);
  }
  if (typeof three === "function") {
    const fn = three as (body: readonly unknown[]) => unknown;
    return {
      ref,
      role: "three-way",
      classify: (body) => {
        try {
          const v = fn(body);
          if (v === "clean" || v === "forbidden-kind" || v === "unreadable") {
            return { shape: "three-way", value: v };
          }
          return { shape: "three-way", value: "THROW", detail: `non-verdict ${JSON.stringify(v)}` };
        } catch (e) {
          return { shape: "three-way", value: "THROW", detail: (e as Error).message?.slice(0, 80) };
        }
      },
    };
  }
  if (typeof bool === "function") {
    const fn = bool as (body: readonly unknown[]) => unknown;
    return {
      ref,
      role: "boolean",
      classify: (body) => {
        try {
          return { shape: "boolean", value: fn(body) ? "REFUSE" : "ALLOW" };
        } catch (e) {
          return { shape: "boolean", value: "THROW", detail: (e as Error).message?.slice(0, 80) };
        }
      },
    };
  }
  throw new Error(`${ref}: no frozen-body classifier role (looked for frozenBodyEgressVerdict and frozenBodyViolatesEgressPolicy)`);
};

const SHA = /^[0-9a-f]{40}$/;
/** Boolean predecessor that #1429 replaced. On origin/main's history. */
const PREDECESSOR = "ee73e33c15f1a147b435d44a6f4feb8fd38512bc";
/** Adapter-free weakening of that predecessor. On origin; not an ancestor of current main. */
const ADAPTER_FREE = "1698fe25356b3160b4ccb77f5b3056182ac8b688";
/** Well-formed and not a commit this checkout should ever contain. Fetch stays off for the control. */
const MISSING_HISTORY_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const gitOk = (args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd: REPO, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

const hasCommit = (sha: string): boolean => gitOk(["cat-file", "-e", `${sha}^{commit}`]);

const ensureCommit = (sha: string, opts: { fetch: boolean }): void => {
  if (!SHA.test(sha)) {
    throw new Error(`missing-history: ${sha} is not a 40-char commit sha`);
  }
  if (hasCommit(sha)) return;
  if (!opts.fetch) {
    throw new Error(`missing-history: ${sha} is not in this checkout and fetch is disabled`);
  }
  try {
    execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", sha], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(
      `missing-history: git fetch --depth=1 origin ${sha} failed: ${(err.stderr ?? err.message ?? "fetch").toString().slice(0, 200)}`,
    );
  }
  if (!hasCommit(sha)) {
    throw new Error(`missing-history: ${sha} still absent after git fetch --depth=1 origin`);
  }
};

const loadedFiles: string[] = [];
const loadArm = async (ref: string, opts: { fetch: boolean } = { fetch: true }): Promise<Arm> => {
  if (ref === "HEAD") {
    const mod = (await import("../src/agui.js")) as Record<string, unknown>;
    return bindRole(mod, "HEAD");
  }
  ensureCommit(ref, opts);
  // Historical copies must sit next to the live src so `./launch.js` and friends resolve.
  // Named with a leading dot and cleaned in `finally` so an interrupted run cannot leave an
  // untracked file that makes mutation-proof refuse the tree.
  const dest = join(SRC_DIR, `.egress-guard-arm-${process.pid}-${ref}.ts`);
  const blob = execFileSync("git", ["show", `${ref}:${AGUI_PATH}`], { encoding: "utf8", cwd: REPO });
  writeFileSync(dest, blob);
  loadedFiles.push(dest);
  const mod = (await import(pathToFileURL(dest).href + `?t=${Date.now()}`)) as Record<string, unknown>;
  return bindRole(mod, ref);
};

const THREAD = "th-1";
const RUN = "run-1";
const EPOCH = "ep-1";
const MARK = "SYNTHETIC-PLACEHOLDER-1433-EGRESS-DIFF-NOT-A-SECRET";

const knownTypes = Object.values(AGUI_EVENT_TYPE);
// #1429: enumerate the forbidden set from the live policy, not a hand-written list. A type
// applyAguiEgressPolicy drops is forbidden; every other known type is allowed. Adding a new
// AGUI_EVENT_TYPE either extends coverage or fails the coverage cell; it cannot silently skip.
const forbiddenTypes = knownTypes.filter(
  (t) => applyAguiEgressPolicy([{ type: t } as AguiEvent]).length === 0,
);
const allowedTypes = knownTypes.filter((t) => !forbiddenTypes.includes(t));

const eventOf = (type: string): AguiEvent => {
  const ts = 1;
  switch (type) {
    case "RUN_STARTED":
      return runStarted({ threadId: THREAD, runId: RUN, timestamp: ts });
    case "RUN_FINISHED":
      return runFinished({ threadId: THREAD, runId: RUN, timestamp: ts });
    case "RUN_ERROR":
      return runError({ message: MARK, timestamp: ts });
    case "TEXT_MESSAGE_START":
      return textMessageStart({ messageId: "m1", timestamp: ts, role: "assistant" });
    case "TEXT_MESSAGE_CONTENT":
      return textMessageContent({ messageId: "m1", delta: "hello", timestamp: ts });
    case "TEXT_MESSAGE_END":
      return textMessageEnd({ messageId: "m1", timestamp: ts });
    case "TOOL_CALL_START":
      return toolCallStart({ toolCallId: "t1", toolCallName: "Read", timestamp: ts });
    case "TOOL_CALL_ARGS":
      return toolCallArgs({ toolCallId: "t1", delta: MARK, timestamp: ts });
    case "TOOL_CALL_END":
      return toolCallEnd({ toolCallId: "t1", timestamp: ts });
    case "TOOL_CALL_RESULT":
      return toolCallResult({ messageId: "res:t1", toolCallId: "t1", content: MARK, timestamp: ts });
    case "REASONING_MESSAGE_START":
      return reasoningMessageStart({ messageId: "r1", timestamp: ts });
    case "REASONING_MESSAGE_CONTENT":
      return reasoningMessageContent({ messageId: "r1", delta: "think", timestamp: ts });
    case "REASONING_MESSAGE_END":
      return reasoningMessageEnd({ messageId: "r1", timestamp: ts });
    case "CUSTOM": {
      const base = textMessageContent({ messageId: "m1", delta: "hello", timestamp: ts });
      return { ...base, type: AGUI_EVENT_TYPE.CUSTOM, name: "undeclared" } as unknown as AguiEvent;
    }
    default:
      throw new Error(`no constructor for ${type}`);
  }
};

const frameOf = (events: AguiEvent[], seq = 0) =>
  aguiFrame({ threadId: THREAD, runId: RUN, epoch: EPOCH, seq, events });

const good = () => frameOf([eventOf("TEXT_MESSAGE_CONTENT")]);
const dirty = (type: "TOOL_CALL_ARGS" | "TOOL_CALL_RESULT") => frameOf([eventOf(type)], 1);
const rt = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const over = (patch: Record<string, unknown>) => Object.assign(good(), patch);

type Body = readonly unknown[] | (() => readonly unknown[]);
const materialise = (body: Body): readonly unknown[] => (typeof body === "function" ? body() : body);

interface Row {
  readonly name: string;
  readonly axis: AxisId;
  readonly body: Body;
}

const ownFlip = (flip: number, clean: AguiEvent[], dirtyEvents: AguiEvent[]) => {
  const f = good();
  const st = { n: 0 };
  delete (f as { events?: unknown }).events;
  Object.defineProperty(f, "events", {
    get: () => (++st.n > flip ? rt(dirtyEvents) : rt(clean)),
    enumerable: true,
    configurable: true,
  });
  return f;
};
const inheritedFlip = (flip: number, clean: AguiEvent[], dirtyEvents: AguiEvent[]) => {
  const st = { n: 0 };
  const proto = {
    get events() {
      return ++st.n > flip ? rt(dirtyEvents) : rt(clean);
    },
  };
  const f = Object.create(proto) as ReturnType<typeof good>;
  for (const [k, v] of Object.entries(good())) if (k !== "events") (f as Record<string, unknown>)[k] = v;
  return f;
};
const proxyFlip = (flip: number, clean: AguiEvent[], dirtyEvents: AguiEvent[]) => {
  const st = { n: 0 };
  const target = { ...good() };
  return new Proxy(target, {
    get: (t, p, r) => (p === "events" ? (++st.n > flip ? rt(dirtyEvents) : rt(clean)) : Reflect.get(t, p, r)),
    getOwnPropertyDescriptor: (t, p) =>
      p === "events"
        ? { value: rt(clean), writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(t, p),
  });
};

const representations = {
  "own getter": ownFlip,
  "inherited getter": inheritedFlip,
  "proxy lying in its descriptor trap": proxyFlip,
} as const;

const CORPUS: Row[] = [];
const push = (axis: AxisId, name: string, body: Body) => {
  CORPUS.push({ axis, name, body });
};

push("control", "control/positive: valid TEXT_MESSAGE_CONTENT", [good()]);
push("control", "control/negative: TOOL_CALL_RESULT", [dirty("TOOL_CALL_RESULT")]);
push("control", "control/negative: TOOL_CALL_ARGS", [dirty("TOOL_CALL_ARGS")]);

push("envelope-protocol", "envelope: protocol wrong version", [over({ protocol: "ag-ui/0.0.1" })]);
push("envelope-protocol", "envelope: protocol missing", () => {
  const f = good();
  delete (f as { protocol?: unknown }).protocol;
  return [f];
});
push("envelope-protocol", "envelope: protocol non-string", [over({ protocol: 7 })]);
push("envelope-threadId", "envelope: threadId empty", [over({ threadId: "" })]);
push("envelope-threadId", "envelope: threadId missing", () => {
  const f = good();
  delete (f as { threadId?: unknown }).threadId;
  return [f];
});
push("envelope-runId", "envelope: runId empty", [over({ runId: "" })]);
push("envelope-runId", "envelope: runId missing", () => {
  const f = good();
  delete (f as { runId?: unknown }).runId;
  return [f];
});
push("envelope-epoch", "envelope: epoch empty", [over({ epoch: "" })]);
push("envelope-epoch", "envelope: epoch missing", () => {
  const f = good();
  delete (f as { epoch?: unknown }).epoch;
  return [f];
});
push("envelope-seq", "envelope: seq -1", [over({ seq: -1 })]);
push("envelope-seq", "envelope: seq 1.5", [over({ seq: 1.5 })]);
push("envelope-seq", "envelope: seq NaN", [over({ seq: Number.NaN })]);
push("envelope-seq", "envelope: seq missing", () => {
  const f = good();
  delete (f as { seq?: unknown }).seq;
  return [f];
});
push("envelope-seq", "envelope: seq Infinity", [over({ seq: Number.POSITIVE_INFINITY })]);

push("events-shape", "events: missing", () => {
  const f = good();
  delete (f as { events?: unknown }).events;
  return [f];
});
push("events-shape", "events: empty array", [over({ events: [] })]);
push("events-shape", "events: string carrying tool bytes", [over({ events: "TOOL_CALL_RESULT: " + MARK })]);
push("events-shape", "events: object {0: TOOL_CALL_RESULT}", [over({ events: { 0: eventOf("TOOL_CALL_RESULT") } })]);
push("events-shape", "events: null", [over({ events: null })]);

push("event-element", "events: null element", [over({ events: [null] })]);
push("event-element", "events: number element", [over({ events: [7] })]);
push("event-element", "events: string element", [over({ events: ["TOOL_CALL_RESULT"] })]);
push("event-element", "events: missing type", [over({ events: [{}] })]);
push("event-element", "events: type null", [over({ events: [{ type: null }] })]);
push("event-element", "events: unknown type WEIRD", [over({ events: [{ type: "WEIRD" }] })]);
push("event-element", "events: nested smuggle", [over({ events: [{ events: [eventOf("TOOL_CALL_RESULT")] }] })]);
push("event-element", "events: case-variant tool_call_result", [over({ events: [{ type: "tool_call_result" }] })]);

for (const type of forbiddenTypes) {
  push("forbidden-kind", `forbidden: well-formed ${type}`, [frameOf([eventOf(type)], 1)]);
}
for (const type of allowedTypes) {
  // CUSTOM is in DIVERGENT: predecessor ALLOW, HEAD THROW (extra-property from spread
  // TextMessageContent siblings). Pinned by identity, not counted in expectStricterMax.
  if (type === "CUSTOM") continue;
  push("allowed-kind", `allowed: well-formed ${type}`, [frameOf([eventOf(type)])]);
}

push("routing-kind", "part: kind wrong (ag-ui.frames)", [over({ kind: "ag-ui.frames" })]);
push("routing-kind", "part: non-object part in body", [good(), "just a string part"]);
push("body-composition", "body: empty body []", []);
push("body-composition", "sibling: valid frame beside junk part", [good(), { kind: "text/markdown", text: "hi" }]);
push("body-composition", "sibling: valid frame beside non-frame carrying events", [
  good(),
  { events: [eventOf("TOOL_CALL_RESULT")] },
]);
push("json-roundtrip", "JSON round-trip of valid frame", [rt(good())]);
push("json-roundtrip", "JSON round-trip of TOOL_CALL_RESULT", [rt(dirty("TOOL_CALL_RESULT"))]);
push("json-roundtrip", "JSON round-trip of TOOL_CALL_ARGS", [rt(dirty("TOOL_CALL_ARGS"))]);

push("iteration-totality", "body: Proxy whose Symbol.iterator throws", () =>
  new Proxy([good()], {
    get(target, prop, recv) {
      if (prop === Symbol.iterator) return function* () { throw new Error("iter boom"); };
      return Reflect.get(target, prop, recv);
    },
  }),
);
push("iteration-totality", "body: array with a throwing index accessor", () => {
  const b: unknown[] = [];
  Object.defineProperty(b, "0", {
    get() {
      throw new Error("idx boom");
    },
    enumerable: true,
    configurable: true,
  });
  return b;
});

push("events-throw", "events: getter on events throws", () => {
  const f = good();
  Object.defineProperty(f, "events", {
    get() {
      throw new Error("events getter boom");
    },
    enumerable: true,
    configurable: true,
  });
  return [f];
});
push("event-type-throw", "events: getter on type throws", () => {
  const f = over({
    events: [
      {
        get type() {
          throw new Error("type boom");
        },
      },
    ],
  });
  return [f];
});

push("frozen-ness", "frozen: Object.freeze of a valid frame body", () => {
  const f = good();
  Object.freeze(f.events);
  return Object.freeze([Object.freeze(f)]);
});
push("frozen-ness", "frozen: Object.freeze of a TOOL_CALL_RESULT body", () => {
  const f = dirty("TOOL_CALL_RESULT");
  Object.freeze(f.events);
  return Object.freeze([Object.freeze(f)]);
});

push("representation", "representation: own getter always TEXT_MESSAGE_CONTENT", () => [ownFlip(99, [eventOf("TEXT_MESSAGE_CONTENT")], [eventOf("TOOL_CALL_RESULT")])]);
push("representation", "representation: inherited getter always TEXT_MESSAGE_CONTENT", () => [
  inheritedFlip(99, [eventOf("TEXT_MESSAGE_CONTENT")], [eventOf("TOOL_CALL_RESULT")]),
]);
push("representation", "representation: proxy descriptor-lie always TEXT_MESSAGE_CONTENT", () => [
  proxyFlip(99, [eventOf("TEXT_MESSAGE_CONTENT")], [eventOf("TOOL_CALL_RESULT")]),
]);

push("same-part-ordering", "same part in CORPUS: bad protocol AND TOOL_CALL_RESULT", () => {
  const f = rt(dirty("TOOL_CALL_RESULT"));
  (f as { protocol: string }).protocol = "ag-ui/0.9";
  return [f];
});
push("same-part-ordering", "same part in CORPUS: seq -1 AND TOOL_CALL_ARGS", () => {
  const f = rt(dirty("TOOL_CALL_ARGS"));
  (f as { seq: number }).seq = -1;
  return [f];
});

for (const [label, make] of Object.entries(representations)) {
  for (const dirtyType of forbiddenTypes as Array<"TOOL_CALL_ARGS" | "TOOL_CALL_RESULT">) {
    const clean = [eventOf("TEXT_MESSAGE_CONTENT")];
    const dirt = [eventOf(dirtyType)];
    for (const flip of [0, 1, 2, 3, 4]) {
      push(
        "representation-flip",
        `accessor/${label}: TEXT_MESSAGE_CONTENT -> ${dirtyType}, flip after ${flip}`,
        () => [make(flip, clean, dirt)],
      );
    }
  }
  for (const allowed of allowedTypes) {
    push(
      "representation-flip",
      `accessor/${label}: ${allowed} -> TOOL_CALL_RESULT, flip after 2`,
      () => [make(2, [eventOf(allowed)], [eventOf("TOOL_CALL_RESULT")])],
    );
    push(
      "representation-flip",
      `accessor/${label}: ${allowed} -> TOOL_CALL_ARGS, flip after 2`,
      () => [make(2, [eventOf(allowed)], [eventOf("TOOL_CALL_ARGS")])],
    );
  }
}

/**
 * Predicted answers, written from a hand-read of origin/main `frozenBodyEgressVerdict`
 * (per-part try, forbidden returns immediately, unreadable is a flag read after the loop;
 * parseAguiFrame runs before the scan) and of PREDECESSOR `frozenBodyViolatesEgressPolicy`
 * (no try, parse throws out of the function). If the harness disagrees, the harness is
 * wrong until that is proven otherwise — not a finding about the guard.
 */
const PREDICT = {
  acrossUnreadableThenForbidden: { boolean: "THROW", threeWay: "forbidden-kind" },
  acrossForbiddenThenUnreadable: { boolean: "REFUSE", threeWay: "forbidden-kind" },
  samePartUnreadableAndForbidden: { boolean: "THROW", threeWay: "unreadable" },
} as const;

interface DivergentRow {
  readonly name: string;
  readonly axis: AxisId;
  readonly body: Body;
  readonly expected: Record<string, Raw["value"]>;
}

const unreadablePart = () => over({ seq: -1 });
const DIVERGENT: DivergentRow[] = [
  // #1432: the closed-schema check intentionally refuses frames whose events carry
  // keys outside the per-type allowlist. The corpus builder (eventOf) constructs CUSTOM
  // by spreading TextMessageContent (adding `messageId` and `delta`), which the
  // predecessor never checked. BaseEventSchema is `.passthrough()` for ALL event types,
  // so the upstream schema would accept the extra keys, but the egress fence enforces
  // the closed shape Cotal publishes: CUSTOM's extension point is `value: z.any()`,
  // not arbitrary sibling keys.
  {
    name: "allowed: well-formed CUSTOM",
    axis: "allowed-kind",
    body: [frameOf([eventOf("CUSTOM")])],
    expected: { [PREDECESSOR]: "ALLOW", HEAD: "THROW", [ADAPTER_FREE]: "ALLOW" },
  },
  {
    name: "across parts: unreadable then TOOL_CALL_RESULT",
    axis: "body-composition",
    body: [unreadablePart(), dirty("TOOL_CALL_RESULT")],
    expected: { [PREDECESSOR]: "THROW", HEAD: "forbidden-kind", [ADAPTER_FREE]: "REFUSE" },
  },
  {
    name: "across parts: TOOL_CALL_RESULT then unreadable",
    axis: "body-composition",
    body: [dirty("TOOL_CALL_RESULT"), unreadablePart()],
    expected: { [PREDECESSOR]: "REFUSE", HEAD: "forbidden-kind", [ADAPTER_FREE]: "REFUSE" },
  },
  {
    name: "across parts: unreadable then TOOL_CALL_ARGS",
    axis: "body-composition",
    body: [unreadablePart(), dirty("TOOL_CALL_ARGS")],
    expected: { [PREDECESSOR]: "THROW", HEAD: "forbidden-kind", [ADAPTER_FREE]: "REFUSE" },
  },
  {
    name: "across parts: TOOL_CALL_ARGS then unreadable",
    axis: "body-composition",
    body: [dirty("TOOL_CALL_ARGS"), unreadablePart()],
    expected: { [PREDECESSOR]: "REFUSE", HEAD: "forbidden-kind", [ADAPTER_FREE]: "REFUSE" },
  },
  {
    name: "same part: bad protocol AND TOOL_CALL_RESULT",
    axis: "same-part-ordering",
    body: () => {
      const f = rt(dirty("TOOL_CALL_RESULT"));
      (f as { protocol: string }).protocol = "ag-ui/0.9";
      return [f];
    },
    expected: { [PREDECESSOR]: "THROW", HEAD: "unreadable", [ADAPTER_FREE]: "REFUSE" },
  },
  {
    name: "same part: seq -1 AND TOOL_CALL_ARGS",
    axis: "same-part-ordering",
    body: () => {
      const f = rt(dirty("TOOL_CALL_ARGS"));
      (f as { seq: number }).seq = -1;
      return [f];
    },
    expected: { [PREDECESSOR]: "THROW", HEAD: "unreadable", [ADAPTER_FREE]: "REFUSE" },
  },
];

/** Held empty: nothing is outside the gate for want of a seam. Count printed so emptiness is a number. */
const HELD: readonly unknown[] = [];

const typesIn = (body: readonly unknown[]): string[] => {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    const rec = v as { type?: unknown; events?: unknown };
    if (typeof rec.type === "string") out.push(rec.type);
    if (rec.events !== undefined) walk(rec.events);
  };
  walk(body);
  return out;
};

const axesCovered = new Set<string>();
const typesCovered = new Set<string>();
for (const row of [...CORPUS, ...DIVERGENT]) {
  axesCovered.add(row.axis);
  try {
    for (const t of typesIn(materialise(row.body))) typesCovered.add(t);
  } catch {
    // a throwing body is still a row; it does not contribute a type
  }
}

const controls = (arm: Arm) => {
  const pos = arm.classify([good()]);
  const negR = arm.classify([dirty("TOOL_CALL_RESULT")]);
  const negA = arm.classify([dirty("TOOL_CALL_ARGS")]);
  const posOk = publishes(pos) === true;
  const negOk = publishes(negR) === false && publishes(negA) === false;
  const roleOk =
    arm.role === "boolean"
      ? pos.value === "ALLOW" && negR.value === "REFUSE" && negA.value === "REFUSE"
      : pos.value === "clean" && negR.value === "forbidden-kind" && negA.value === "forbidden-kind";
  return { pos, negR, negA, ok: posOk && negOk && roleOk };
};

interface Pair {
  readonly name: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly expectWeakerMin: number;
  readonly expectStricterMax: number;
}

const PAIRS: Pair[] = [
  {
    name: "adapter-free predecessor vs adapter-free weakening",
    baseRef: PREDECESSOR,
    headRef: ADAPTER_FREE,
    expectWeakerMin: 1,
    expectStricterMax: 99,
  },
  {
    name: "primary predecessor vs HEAD",
    baseRef: PREDECESSOR,
    headRef: "HEAD",
    expectWeakerMin: 0,
    // Zero: every known divergence is pinned by identity in DIVERGENT, not counted here.
    // A new STRICTER row fails loudly rather than slotting into a numeric budget.
    expectStricterMax: 0,
  },
];

const fmt = (raw: Raw) => (raw.detail ? `${raw.value}(${raw.detail})` : raw.value);

const gradePair = (base: Arm, head: Arm, pair: Pair) => {
  const before = { base: controls(base), head: controls(head) };
  ok(
    `${pair.name}: controls BEFORE the corpus (positive publishes, both forbidden types withhold)`,
    before.base.ok && before.head.ok,
    {
      base: { pos: fmt(before.base.pos), negR: fmt(before.base.negR), negA: fmt(before.base.negA) },
      head: { pos: fmt(before.head.pos), negR: fmt(before.head.negR), negA: fmt(before.head.negA) },
    },
  );

  const weaker: string[] = [];
  const stricter: string[] = [];
  const byAxis: Record<string, { weaker: number; stricter: number; n: number }> = {};
  for (const axis of AXES) byAxis[axis.id] = { weaker: 0, stricter: 0, n: 0 };

  for (const row of CORPUS) {
    const bodyB = materialise(row.body);
    const bodyH = materialise(row.body);
    const b = base.classify(bodyB);
    const h = head.classify(bodyH);
    const slot = byAxis[row.axis]!;
    slot.n += 1;
    const w = !publishes(b) && publishes(h);
    const s = publishes(b) && !publishes(h);
    if (w) {
      weaker.push(row.name);
      slot.weaker += 1;
      console.log(`  WEAKER | base=${fmt(b).padEnd(16)} | head=${fmt(h).padEnd(16)} | ${row.name}`);
    } else if (s) {
      stricter.push(row.name);
      slot.stricter += 1;
      console.log(`  STRICT | base=${fmt(b).padEnd(16)} | head=${fmt(h).padEnd(16)} | ${row.name}`);
    }
  }

  for (const row of DIVERGENT) {
    const b = base.classify(materialise(row.body));
    const h = head.classify(materialise(row.body));
    const wantB = row.expected[base.ref];
    const wantH = row.expected[head.ref];
    ok(`declared divergence, both answers as pinned: ${row.name} [${pair.name}]`, b.value === wantB && h.value === wantH, {
      base: fmt(b),
      head: fmt(h),
      expected: { base: wantB, head: wantH },
    });
  }

  const after = { base: controls(base), head: controls(head) };
  ok(
    `${pair.name}: controls AFTER the corpus (an arm that died mid-run is caught)`,
    after.base.ok && after.head.ok,
    {
      base: { pos: fmt(after.base.pos), negR: fmt(after.base.negR), negA: fmt(after.base.negA) },
      head: { pos: fmt(after.head.pos), negR: fmt(after.head.negR), negA: fmt(after.head.negA) },
    },
  );

  ok(
    `${pair.name}: WEAKER count is ${pair.expectWeakerMin === 0 ? "zero" : "at least " + String(pair.expectWeakerMin)} (base withheld, head published)`,
    weaker.length >= pair.expectWeakerMin && (pair.expectWeakerMin === 0 ? weaker.length === 0 : true),
    { weaker: weaker.length, names: weaker.slice(0, 20) },
  );
  ok(
    `${pair.name}: STRICTER count is at most ${pair.expectStricterMax} (base published, head withheld)`,
    stricter.length <= pair.expectStricterMax && (pair.expectStricterMax === 0 ? stricter.length === 0 : true),
    { stricter: stricter.length, names: stricter.slice(0, 20) },
  );

  console.log(`  (${pair.name}: ${CORPUS.length} corpus rows, WEAKER ${weaker.length}, STRICTER ${stricter.length})`);
  console.log("  axes covered / weaker / stricter:");
  for (const axis of AXES) {
    const slot = byAxis[axis.id]!;
    console.log(`    ${axis.id}: n=${slot.n} weaker=${slot.weaker} stricter=${slot.stricter}`);
  }
  const uncovered = AXES.map((a) => a.id).filter((id) => (byAxis[id]?.n ?? 0) === 0);
  ok(`${pair.name}: every named axis has at least one corpus row`, uncovered.length === 0, uncovered);
};

try {
  ok("ORIGINAL_AXES is the committed 15", ORIGINAL_AXES.length === 15, ORIGINAL_AXES.length);
  ok("APPENDED_AXES is append-only (5)", APPENDED_AXES.length === 5, APPENDED_AXES.length);
  ok(
    "KNOWN_AGUI_EVENT_TYPES from this sha is 14",
    knownTypes.length === 14,
    knownTypes,
  );
  ok(
    "EGRESS_FORBIDDEN_TYPES from this sha is TOOL_CALL_ARGS and TOOL_CALL_RESULT",
    forbiddenTypes.length === 2 &&
      forbiddenTypes.includes("TOOL_CALL_ARGS") &&
      forbiddenTypes.includes("TOOL_CALL_RESULT"),
    forbiddenTypes,
  );
  const missingTypes = knownTypes.filter((t) => !typesCovered.has(t));
  ok(
    "the corpus spans every known event type, computed from the source's own set",
    missingTypes.length === 0,
    { missingTypes, covered: [...typesCovered].sort() },
  );
  ok("HELD is empty, and that count is printed rather than left to notice", HELD.length === 0, HELD.length);
  console.log(`  (${HELD.length} held; an empty list is not coverage)`);
  ok("CORPUS is non-empty", CORPUS.length > 0, CORPUS.length);

  const agreeing = DIVERGENT.filter((r) => r.expected[PREDECESSOR] === r.expected.HEAD).map((r) => r.name);
  ok(
    "every declared divergence names two different answers on predecessor vs HEAD",
    agreeing.length === 0,
    agreeing,
  );
  ok(
    "PREDICT across-unreadable-then-forbidden matches the predecessor/HEAD pins",
    DIVERGENT[1]!.expected[PREDECESSOR] === PREDICT.acrossUnreadableThenForbidden.boolean &&
      DIVERGENT[1]!.expected.HEAD === PREDICT.acrossUnreadableThenForbidden.threeWay,
  );
  ok(
    "PREDICT across-forbidden-then-unreadable matches the predecessor/HEAD pins",
    DIVERGENT[2]!.expected[PREDECESSOR] === PREDICT.acrossForbiddenThenUnreadable.boolean &&
      DIVERGENT[2]!.expected.HEAD === PREDICT.acrossForbiddenThenUnreadable.threeWay,
  );
  ok(
    "PREDICT same-part unreadable-beats-forbidden matches the predecessor/HEAD pins",
    DIVERGENT[5]!.expected[PREDECESSOR] === PREDICT.samePartUnreadableAndForbidden.boolean &&
      DIVERGENT[5]!.expected.HEAD === PREDICT.samePartUnreadableAndForbidden.threeWay,
  );

  let missingHistory = "";
  try {
    await loadArm(MISSING_HISTORY_SHA, { fetch: false });
  } catch (e) {
    missingHistory = (e as Error).message ?? "";
  }
  ok(
    "missing-history control: a well-formed SHA that is not in the checkout, with fetch disabled, throws missing-history:",
    missingHistory.startsWith("missing-history:") && !missingHistory.includes("HEAD"),
    missingHistory,
  );

  const arms: Record<string, Arm> = {};
  for (const ref of [PREDECESSOR, ADAPTER_FREE, "HEAD"]) {
    arms[ref] = await loadArm(ref);
    ok(`${ref}: classifier role bound`, Boolean(arms[ref]), arms[ref]?.role);
  }
  ok("adapter-free pair is boolean both sides", arms[PREDECESSOR]!.role === "boolean" && arms[ADAPTER_FREE]!.role === "boolean");
  ok("HEAD is the three-way role", arms.HEAD!.role === "three-way", arms.HEAD!.role);

  for (const pair of PAIRS) {
    gradePair(arms[pair.baseRef]!, arms[pair.headRef]!, pair);
  }
} finally {
  for (const f of loadedFiles) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* leave no arm file behind even if unlink races */
    }
  }
}

console.log(
  `\negress-guard-differential: ${pass + failures.length} cells, ${pass} passed, ${failures.length} failed; ${CORPUS.length} corpus rows, ${DIVERGENT.length} divergent, ${HELD.length} held`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAILED: ${f}`);
  process.exitCode = 1;
}
