import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { CommandFailure, connectorConfigModeProblem, protectedLocalDirectory } from "@cotal-ai/workspace";
import type { ConnectorConfigRepairResult } from "./protocol.js";

/** Change only the current mode gap on a directory this account owns. */
export function repairConnectorConfigMode(): ConnectorConfigRepairResult {
  const gap = connectorConfigModeProblem(true);
  if (!gap) return { path: null, mode: null };
  const { path, remove, failure } = gap;
  const uid = process.getuid?.();
  if (uid === undefined || !gap.owned) throw new CommandFailure("refused", "PERMISSION_DENIED", `the connector config folder ${path} is owned by another account; no permissions were changed`);
  protectedLocalDirectory(dirname(path), "the parent of the connector config folder");
  const before = lstatSync(path);
  if (before.uid !== uid) throw new CommandFailure("refused", "PERMISSION_DENIED", `the connector config folder ${path} is owned by another account; no permissions were changed`);
  if (!before.isDirectory() || (before.mode & 0o7777) !== gap.mode) throw failure;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(fd);
    if (current.uid !== uid || current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode)
      throw new CommandFailure("refused", "CONFLICT", "the connector config folder changed before repair; no permissions were changed");
    fchmodSync(fd, (current.mode & 0o7777) & ~remove);
    return { path, mode: fstatSync(fd).mode & 0o7777 };
  } finally { closeSync(fd); }
}
