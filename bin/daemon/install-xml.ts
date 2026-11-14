import { CommandFailure } from "@cotal-ai/workspace/local-observation";

/** XML character data: bounded, without controls or code points XML cannot carry, and escaped. */
export function xmlText(value: string): string {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value) || [...value].some((scalar) => {
    const cp = scalar.codePointAt(0)!;
    return cp >= 0xd800 && cp <= 0xdfff || cp === 0xfffe || cp === 0xffff;
  })) throw new CommandFailure("refused", "USAGE_INVALID", "the daemon job needs bounded XML text without control or invalid Unicode characters; no job bytes were prepared");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
