import { resolve } from "node:path";
import ts from "typescript";

const parsed = new Map();

/** Keep one current parse per file; changed text replaces it rather than reusing stale nodes. */
export function sourceAst(path, source) {
  const key = resolve(path);
  const previous = parsed.get(key);
  if (previous?.source === source) return previous.sf;
  const sf = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true);
  parsed.set(key, { source, sf });
  return sf;
}
