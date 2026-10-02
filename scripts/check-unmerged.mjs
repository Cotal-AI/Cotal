// While the index holds unmerged paths, `git diff --exit-code` prints a combined
// diff and still exits 0, so its answer cannot be trusted as pass/fail. This gate
// refuses up front and names the paths that must be staged first.
import { execFileSync } from "node:child_process";

const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
  encoding: "utf8",
});
const unmerged = out.split("\n").filter(Boolean);
if (unmerged.length > 0) {
  console.error(
    "check:docsbundle: the index holds unmerged paths, so git diff --exit-code cannot answer; stage the resolution first:",
  );
  for (const path of unmerged) console.error(path);
  process.exit(1);
}
