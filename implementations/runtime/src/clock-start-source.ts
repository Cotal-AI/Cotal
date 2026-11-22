// Track nesting without walking or reviving unrelated values on the call stack.
function memberValueOffset(text: string, objectOffset: number, name: string): number | undefined {
  let depth = 0;
  let atKey = true;
  for (let i = objectOffset + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (depth === 0 && atKey) {
        atKey = false;
        if (JSON.parse(text.slice(i, end + 1)) === name) return text.indexOf(":", end + 1) + 1;
      }
      i = end;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      if (depth === 0) return undefined;
      depth--;
    } else if (ch === "," && depth === 0) {
      atKey = true;
    }
  }
  return undefined;
}

/** Read the raw token from a validated, duplicate-free handler with an object clock and numeric start. */
export function clockStartSource(text: string): string | undefined {
  const clock = memberValueOffset(text, text.indexOf("{"), "clock");
  if (clock === undefined) return undefined;
  const start = memberValueOffset(text, text.indexOf("{", clock), "start");
  if (start === undefined) return undefined;
  const token = /\s*([^,\s}]+)/y;
  token.lastIndex = start;
  return token.exec(text)?.[1];
}
