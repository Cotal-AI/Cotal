/** Whether a debugging switch is on. Unset, empty, `0`, `false` and `off`, in any case, read as off,
 *  so a value written to turn it off does; any other value turns it on. */
export function debugFlag(name: "COTAL_DEBUG" | "COTAL_COMPLETE_DEBUG"): boolean {
  const value = process.env[name]?.toLowerCase();
  return !!value && value !== "0" && value !== "false" && value !== "off";
}
