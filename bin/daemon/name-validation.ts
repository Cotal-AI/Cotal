/** One display-name rule shared by the renderer and local daemon entry points. */
export function computerName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a computer name.");
  const name = value.trim();
  if (!name || [...name].length > 128 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new Error("Use 1 to 128 characters with no control characters or line breaks.");
  return name;
}
