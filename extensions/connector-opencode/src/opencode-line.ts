/** Parses `opencode --version` output into the major protocol line: 1 (opencode-ai) or 2
 *  (@opencode/cli). Pure so both launch.ts (the launcher) and extension.ts (the model catalog) can
 *  detect the line from the same rule with no fallback for anything else. */
export function opencodeLine(raw: string, bin: string): 1 | 2 {
  const m = raw.match(/(?:^|v)(\d+)\.\d+/);
  const major = m ? Number(m[1]) : NaN;
  if (major === 1 || major === 2) return major;
  throw new Error(
    `opencode connector: unsupported OpenCode version "${raw}" from ${bin}; this connector supports the 1.x (opencode-ai) and 2.x (@opencode/cli) lines`,
  );
}
