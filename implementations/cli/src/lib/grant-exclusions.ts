/** `text` followed by the channels or patterns that remove channels from it (SPEC §9). */
export const exceptText = (text: string, exclude: readonly string[] | undefined): string =>
  exclude?.length ? `${text} except ${exclude.join(", ")}` : text;
