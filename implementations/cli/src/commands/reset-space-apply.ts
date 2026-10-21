import * as prompts from "../lib/prompts.js";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { isLoopbackLiteral, type ParsedArgs } from "@cotal-ai/core";
import {
  acquireMaintenanceLock, canonicalRoot, CommandFailure, findMesh, localMeshesForRoot, oneLine, presentationOf,
  releaseMaintenanceLock, removeMeshesByRoot, renderReport, terminalWidth, writeResult, type Report,
} from "@cotal-ai/workspace";
import { assertResetIdentityRemoved, planResetSpaceIdentity, recheckResetSpaceIdentity, reviewedResetIdentityCleanup, resetSpaceIdentityProjection } from "../lib/reset-space-plan.js";
import { removeLocalState, type safeStoreCleanupPath } from "./clean.js";
import { canPrompt } from "./meshes-wizard.js";
import { assertResetEligible, selectResetTarget } from "./reset-store-apply.js";

/** Named local clean-all composition. It never stops a process, calls a remote reset or logs out
 * an IdP account. Native secret deprovisioning remains ahead of raw identity/trust removal. */
export async function resetSpaceApply(space: string, args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values), dryRun = args.values["dry-run"] === true, yes = args.values.yes === true;
  if (!dryRun && !yes && (!canPrompt() || presentation === "json")) throw new CommandFailure("refused", "USAGE_INVALID", "reset space needs a terminal confirmation or --yes with the exact space name", { target: { space }, remedy: "review reset space <space> --dry-run first" });
  const selected = selectResetTarget(space, "reset space");
  const root = selected.root, target = { space, root };
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "this guarded identity reset currently needs Linux process-custody observations; no other platform was treated as stopped", { target });
  let address: URL;
  try { address = new URL(selected.server); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the local reset has no single usable recorded broker address", { target }); }
  if (selected.tlsRequired || address.protocol !== "nats:" || address.username || address.password || address.search || address.hash || !isLoopbackLiteral(address.hostname.replace(/^\[|\]$/g, "")) || selected.remoteUser) throw new CommandFailure("refused", "UNSUPPORTED", "reset space requires its local plain-NATS loopback broker; TLS-first, remote and ambiguous listener checks are not substituted", { target });
  if (root === canonicalRoot(homedir()) || selected.storeDir !== undefined && !isAbsolute(selected.storeDir)) throw new CommandFailure("refused", "CONFLICT", "the root or store path is not one isolated absolute project target", { target });

  const eligible = async (): Promise<ReturnType<typeof safeStoreCleanupPath>> => {
    const store = await assertResetEligible(selected, "reset space");
    if (!store.identity && lstatSync(store.path, { throwIfNoEntry: false }))
      throw new CommandFailure("refused", "CONFLICT", "the store path exists but is not a pinned real directory; nothing was removed", { target: { ...target, store: store.path } });
    return store;
  };
  const expected = await eligible();
  const plan = await planResetSpaceIdentity(root, space, selected.mode);
  const impact = { kind: "reset-space-impact" as const, space, root, storePath: expected.path, storeState: expected.identity ? "present-with-pinned-directory" : "absent-at-read", identity: resetSpaceIdentityProjection(plan), registration: selected.source === "registration" ? "only-this-local-up-entry" : "none-recorded-prepared-record-and-journal-kept", preserved: ["personas", "service definitions and stopped-instance records", "installed packages", "login sessions and remote data"], dryRun, effectAttempted: false };
  const impactView = (): Report => ({ space, sections: [{ title: "Reset space impact", blocks: [
    { kind: "fields", rows: [["Space", space], ["Root", root], ["Store", impact.storePath], ["Store observation", impact.storeState], ["Identity paths", String(impact.identity.paths.length)], ["Auth provider", impact.identity.provider ?? "none registered"], ["Declared provider keys", String(impact.identity.providerKeyCount)], ["Trust", impact.identity.trust], ["Registration", impact.registration]] },
    { kind: "table", columns: [{ key: "path", label: "Identity path under root" }, { key: "state", label: "Observed state" }], rows: impact.identity.paths.slice(0, 100) },
    { kind: "lines", lines: [...(impact.identity.paths.length > 100 ? ["Additional paths are retained in --json output."] : []), selected.source === "registration" ? "Removes the stopped store, local credential/identity material and this locally created registration." : "Removes the stopped store and local credential/identity material. The space has no registration; its prepared record and stack journal stay, so a later up starts it with a new identity.", "Keeps personas, service definitions, installed packages, IdP login sessions and remote data. No process is stopped and no remote authority is revoked."] },
  ] }] });
  if (dryRun) {
    // Every check passed, so the verdict is that the apply is offered; it runs them all again.
    writeResult(presentation, { command: "reset", target, result: { ...impact, applyVerdict: { offered: true } } }, () => {
      const view = impactView();
      return { ...view, sections: [...view.sections, { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal reset space ${space} --yes`, description: "Apply it; every check runs again under the root's maintenance lock" }] }] }] };
    });
    return;
  }
  if (!yes) {
    console.error(renderReport({ ...impactView(), space }, presentation === "plain" ? "plain" : "rich", terminalWidth(process.stderr)));
    const answer = await prompts.confirm({ message: `Remove the reviewed stopped store and local identity for ${oneLine(space)}?`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) {
      writeResult(presentation, { command: "reset", target, result: { kind: "reset-space", confirmed: false, removedPaths: [], registrationRemoved: false }, noOp: true }, (): Report => ({ sections: [{ title: "Space kept", blocks: [{ kind: "lines", lines: ["No reset was submitted. Local store, identity and registration were kept."] }] }] }));
      return;
    }
  }
  let lock: ReturnType<typeof acquireMaintenanceLock>;
  try { lock = acquireMaintenanceLock(root); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the exclusive root maintenance lock could not be acquired; no reset was submitted", { target }); }
  const removed: string[] = [];
  // A deletion through the reviewed secret store is reported by the store and again by the local
  // cleanup. The receipt lists each path once, keeping the annotated label when there is one.
  const unannotated = (label: string) => label.replace(/ \([^()]*\)$/, "");
  const record = (label: string) => {
    const index = removed.findIndex((row) => unannotated(row) === unannotated(label));
    if (index === -1) removed.push(label);
    else if (label !== unannotated(label)) removed[index] = label;
  };
  let submitted = false, cleanupReturned = false, registrationRemoved = false;
  let failure: CommandFailure | undefined;
  try {
    const currentStore = await eligible();
    if (currentStore.path !== expected.path || Boolean(currentStore.identity) !== Boolean(expected.identity) || currentStore.identity && (currentStore.identity.dev !== expected.identity?.dev || currentStore.identity.ino !== expected.identity?.ino)) throw new Error("store identity changed");
    recheckResetSpaceIdentity(plan);
    submitted = true;
    await removeLocalState(root, { includeAuth: true, storeDir: selected.storeDir, expectedStore: expected, identity: reviewedResetIdentityCleanup(plan, record), onRemoved: record });
    assertResetIdentityRemoved(plan);
    if (lstatSync(expected.path, { throwIfNoEntry: false })) throw new Error("store remains after cleanup");
    cleanupReturned = true;
    // A stopped controller stack has no registration; its prepared record and journal stay so a
    // later up starts it with a new identity.
    if (selected.source === "registration") {
      // Native deletion is synchronous after the final exact registration check. Its own helper
      // preserves manual/catalog records and releases only a selection naming a removed local entry.
      const current = findMesh(space), local = localMeshesForRoot(root);
      if (!current || JSON.stringify(current) !== selected.fingerprint || local.length !== 1 || local[0]?.space !== space) throw new CommandFailure("partial", "OPERATION_PARTIAL", "local cleanup returned, but the registration changed; the replacement registration was not removed", { target, changed: removed });
      removeMeshesByRoot(root);
      if (findMesh(space)) throw new Error("registration removal did not settle");
      registrationRemoved = true;
    }
  } catch (error) {
    failure = submitted || error instanceof CommandFailure
      ? error instanceof CommandFailure ? error : new CommandFailure("unknown", "OPERATION_UNKNOWN", "the local identity reset did not confirm its complete outcome; no deletion or provider operation was retried", { target, changed: removed, remedy: "inspect the original store, local identity paths and registration before another reset; partial cleanup is not an unused identity" })
      : new CommandFailure("refused", "CONFLICT", "the reviewed registration, root custody, store or identity paths changed before cleanup; no reset was submitted", { target });
  } finally {
    try { releaseMaintenanceLock(lock); }
    catch { if (!failure) failure = new CommandFailure("partial", "OPERATION_PARTIAL", "the reset returned, but maintenance lock release did not confirm", { target, changed: [...removed, ...(registrationRemoved ? [{ space, registrationRemoved: true }] : [])] }); }
  }
  writeResult(presentation, { command: "reset", target, result: { kind: "reset-space", space, root, storePath: expected.path, removedPaths: removed, localIdentityRemoved: cleanupReturned, registrationRemoved, remoteRevocation: "not-performed", preserved: impact.preserved }, ...(failure ? { failure } : {}) }, (data): Report => ({ sections: [{ title: failure ? "Local reset incomplete" : "Local space reset", blocks: [
    { kind: "fields", rows: [["Space", data.space], ["Store", data.storePath], ["Local identity", data.localIdentityRemoved ? "removed and checked absent" : "not confirmed removed"], ["Local registration", data.registrationRemoved ? "removed" : selected.source === "stopped-stack" ? "none recorded; the prepared record and stack journal stay" : "not confirmed removed"], ["Remote revocation", "not performed"]] },
    { kind: "lines", lines: data.removedPaths.slice(0, 100) },
    { kind: "lines", lines: [...(data.removedPaths.length > 100 ? ["Additional returned deletion receipts are in JSON."] : []), "Personas, service definitions, installed packages and account login sessions were kept. This resets local files, not Cloud data or a remote broker's authority.", failure ? "Inspect the retained original paths and registration before any new startup or reset." : "A later up creates a new local identity."] },
  ] }] }));
}
