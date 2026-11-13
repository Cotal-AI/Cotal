import assert from "node:assert/strict";
import { splash } from "../src/lib/theme.js";

let checks = 0;
const ok = (cond: boolean, message: string, extra?: string): void => {
  assert.ok(cond, extra === undefined ? message : `${message}\n${extra}`);
  checks++;
  console.log(`  ✓ ${message}`);
};

function drawn(columns: number | undefined): string {
  const previous = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const write = process.stdout.write;
  const chunks: string[] = [];
  Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => columns });
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    splash();
  } finally {
    process.stdout.write = write;
    if (previous) Object.defineProperty(process.stdout, "columns", previous);
    else delete (process.stdout as { columns?: number }).columns;
  }
  return chunks.join("");
}

function ruleLength(text: string): number {
  const line = text.split("\n").find((item) => item.includes("─"));
  assert.ok(line, text);
  return line.match(/─+/)?.[0].length ?? 0;
}

const zero = drawn(0);
ok(zero.includes("the web for agents") && !zero.includes("Invalid count"), "0 columns still draws the splash", zero);
ok(ruleLength(zero) === 44, "0 columns draws the 80-column rule", zero);
ok(ruleLength(drawn(undefined)) === 44, "a missing column count draws the 80-column rule");
ok(ruleLength(drawn(10)) === 8, "10 columns draws a rule two shorter than the terminal");
ok(ruleLength(drawn(140)) === 44, "a wide terminal caps the rule at 44");

console.log(`setup zero columns: ${checks} checks passed`);
