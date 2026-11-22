import { KEY_RESERVED_RE, SINGLE_BODY_BRANCH } from "./keys.js";
import { PRIMITIVES, STEP_NAME_RE } from "./primitives.js";

const segment = /^([^#:]+)(?::([^#:]*))?#(?:0|[1-9][0-9]*)$/;
const ordinal = /^(?:0|[1-9][0-9]*)$/;

function readSegment(text: string) {
  const match = segment.exec(text);
  const kind = match?.[1];
  if (kind === undefined || !Object.hasOwn(PRIMITIVES, kind)) return undefined;
  const primitive = PRIMITIVES[kind]!;
  const name = match?.[2];
  if (primitive.nameRequired && (name === undefined || !STEP_NAME_RE.test(name))) return undefined;
  return { kind, name, primitive };
}

function validFrame(text: string, branch: string): boolean {
  const frame = readSegment(text);
  if (frame === undefined || !branch.startsWith("b:")) return false;
  const key = branch.slice(2);
  if (frame.kind === "waitUntil") return ordinal.test(key);
  if (frame.primitive.scope === null) return false;
  if (frame.kind === "conclave" || frame.kind === "once") return key === SINGLE_BODY_BRANCH;
  return !KEY_RESERVED_RE.test(key);
}

/** The effect kind in a full or short fault key, or undefined for invalid syntax. */
export function simFaultStepKind(key: string): string | undefined {
  const parts = key.split("/");
  const step = readSegment(parts.pop()!);
  if (step === undefined || step.primitive.kind === null || step.name === "") return undefined;
  if (parts.length === 0) return step.primitive.kind;
  if (parts[0] !== "" || parts.length % 2 !== 1) return undefined;
  for (let i = 1; i < parts.length; i += 2) {
    if (!validFrame(parts[i]!, parts[i + 1]!)) return undefined;
  }
  return step.primitive.kind;
}
