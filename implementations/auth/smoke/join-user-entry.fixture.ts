import "../src/index.js";
import { commandFailureReport, exitCode, isCommandFailure, renderReport } from "@cotal-ai/workspace";
import { join } from "../../cli/src/commands/join.js";
// A refusal is reported by its classified report, with its code, and exits with the status the
// outcome table gives that code.
try {
  await join({ values: JSON.parse(process.env.JOIN_VALUES!), positionals: [], raw: [] });
} catch (e) {
  if (!isCommandFailure(e)) throw e;
  process.stderr.write(`${renderReport(commandFailureReport(e), "plain")}\n`);
  process.exit(exitCode(e.outcome, e.code));
}
