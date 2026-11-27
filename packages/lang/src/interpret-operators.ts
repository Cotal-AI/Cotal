/** The walker's operator semantics on primitives: the binary operators, the update operand check, the
 *  no-coercion refusal and canonical array indexes. A leaf: it imports only the error types and the
 *  value-size bounds. */
import {
  RuntimeFault,
  InterpreterDefect,
} from "./errors.js";
import { assertStringFits } from "./limits.js";

/** Refuse a container or function where a primitive is needed: there is no implicit conversion. */
export function refuseCoercion(where: string, v: unknown): void {
  if (v !== null && (typeof v === "object" || typeof v === "function")) {
    const kind = typeof v === "function" ? "a function" : Array.isArray(v) ? "an array" : "a record";
    throw new RuntimeFault(
      "L4018",
      `\`${where}\` cannot take ${kind}: there is no implicit conversion here, because converting would read \`valueOf\`/\`toString\` off the value — host machinery this language does not have. Convert explicitly: \`json.stringify(value)\` for text, or read the field you mean.`,
    );
  }
}

/**
 * Refuse an update's operand (`x++`, `--o.count`) that is not already a number: the same L4018
 * sentence the compiled engine's `case "update"` throws (`engine/ctx.ts`), so `x++`, `x + 1` and
 * `x += 1` refuse the same operand the same way rather than one of the three quietly coercing it.
 */
export function refuseNonNumberUpdate(v: unknown): asserts v is number {
  if (typeof v === "number") return;
  const kind = v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`;
  throw new RuntimeFault(
    "L4018",
    `\`++\` and \`--\` count, and ${kind} is not a number, so there is nothing to count. Nothing is converted for you here: parse it first (\`number(value)\`), or hold the counter in a number.`,
  );
}

/**
 * The binary operators, with JavaScript's meaning ON PRIMITIVES. `"a" + 1`, `true + 1` and
 * `null + 1` mean here exactly what they mean in JavaScript — primitive coercion is pure and
 * deterministic. A record, an array or a function operand is refused (L4018), a declared
 * difference: JavaScript would reach for the host's ToPrimitive machinery, which reads `valueOf`/
 * `toString` off the value — own fields a program can set to its OWN closures. Measured before the
 * refusal: `o + 1` invoked such a closure without an interpreter frame and crashed with a raw host
 * TypeError, and without one it silently produced `"[object Object]1"`. `==` and `!=` never reach
 * this function: the validator refuses them (L1025). `===`/`!==` compare identity and take any
 * operands.
 */
export function applyBinary(op: string, l: unknown, r: unknown): unknown {
  const a = l as number;
  const b = r as number;
  switch (op) {
    case "===":
      return l === r;
    case "!==":
      return l !== r;
    default:
      break;
  }
  refuseCoercion(op, l);
  refuseCoercion(op, r);
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "+":
      if (typeof l === "string" || typeof r === "string") assertStringFits("`+`", String(l).length + String(r).length);
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "%":
      return a % b;
    case "**":
      return a ** b;
    case "&":
      return a & b;
    case "|":
      return a | b;
    case "^":
      return a ^ b;
    case "<<":
      return a << b;
    case ">>":
      return a >> b;
    case ">>>":
      return a >>> b;
    default:
      throw new InterpreterDefect(`the operator ${op}`);
  }
}

/** A canonical array index (`"0"`, `"12"`), as a number, or nothing. */
export function arrayIndex(prop: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(prop)) return undefined;
  const n = Number(prop);
  return n <= 4294967294 ? n : undefined;
}
