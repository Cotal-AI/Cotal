import { BUILT_IN_PACKAGES } from "@cotal-ai/workspace";

/** A registry operand naming a package that the CLI already provides. */
export function builtInExtension(spec: string | undefined): string | undefined {
  const name = spec?.match(/^(@cotal-ai\/[^/@]+)(?:@[^/]*)?$/)?.[1];
  return name && Object.hasOwn(BUILT_IN_PACKAGES, name) ? name : undefined;
}
