import { extensionCorePeerProblem } from "@cotal-ai/workspace";
import { seedWriterKind } from "../seed/paths.js";

export function assertExtensionCorePeer(pkg: string, range: string | undefined): void {
  if (range === undefined || range === "*") return;
  const problem = extensionCorePeerProblem(pkg, range, { checkout: seedWriterKind() === "checkout" });
  if (problem) throw new Error(problem);
}
