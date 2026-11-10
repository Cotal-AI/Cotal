/** Directory identity persists through journals, legacy upgrades and completed restores. */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSuite } from "@cotal-ai/smoke-kit";
import { readStackJournal, writeStackJournal, type StackJournal } from "../src/lib/stack-journal.js";
import { readStoreIdentity, stackStoreWarnings } from "../src/lib/store-identity.js";
import { settleControllerResume } from "../src/lib/controller-resume.js";

const suite = createSuite();
const root = mkdtempSync(join(tmpdir(), "cotal-store-identity-")), store = join(root, "custom-store");
mkdirSync(join(root, ".cotal"));
mkdirSync(store);
const now = new Date().toISOString();
const journal: StackJournal = {
  schemaVersion: 1, kind: "cotal-stack-controller", root, space: "identity", server: "nats://127.0.0.1:43210", mode: "auth",
  broker: { storeDir: store, storeIdentity: readStoreIdentity(store) },
  members: ["broker", "auth", "delivery", "manager"].map((role) => ({ role, definition: `stack-${role}`, instanceId: null, state: "not-attempted" })) as StackJournal["members"],
  operation: { id: randomUUID(), kind: "up", phase: "completed", recordedAt: now, withAgents: false }, updatedAt: now,
};
const saved = writeStackJournal(root, undefined, journal);
suite.check("journal round trip keeps all store identity fields", JSON.stringify(readStackJournal(root)?.journal.broker) === JSON.stringify(journal.broker));
suite.check("an unchanged custom store has no warning", stackStoreWarnings(journal).length === 0);
writeFileSync(join(store, "ordinary-file"), "changing contents does not change directory identity");
suite.check("ordinary directory content changes do not warn", stackStoreWarnings(journal).length === 0);
const legacy = { ...journal, broker: { storeDir: store } };
writeStackJournal(root, saved, legacy);
suite.check("legacy journals without an identity still read", readStackJournal(root)?.journal.broker?.storeIdentity === undefined);
suite.check("legacy journals do not invent a replacement identity", stackStoreWarnings(legacy).length === 0);
renameSync(store, `${store}.old`);
suite.check("a missing legacy store still warns on restart", stackStoreWarnings(legacy, true)[0]?.code === "STORE_MISSING");
mkdirSync(store);
suite.check("an existing legacy store cannot prove a replacement", stackStoreWarnings(legacy).length === 0);
suite.check("a new directory at a custom path reports replacement", stackStoreWarnings(journal)[0]?.code === "STORE_REPLACED");
renameSync(store, `${store}.new`);
symlinkSync(`${store}.old`, store, process.platform === "win32" ? "junction" : "dir");
suite.check("retargeting the store through a link reports replacement", stackStoreWarnings(journal)[0]?.code === "STORE_REPLACED");
const restored = join(root, "restored-store");
mkdirSync(restored);
settleControllerResume(root, "completed", { storeDir: restored });
const resumed = readStackJournal(root)!.journal;
suite.check("completed restore records the target directory identity", JSON.stringify(resumed.broker?.storeIdentity) === JSON.stringify(readStoreIdentity(restored)));
suite.check("completed restore does not leave a false replacement warning", stackStoreWarnings(resumed).length === 0);
const path = join(root, ".cotal", "stack-controller.json"), bytes = readFileSync(path, "utf8");
for (const invalid of [{ ...resumed.broker!.storeIdentity, ino: 1 }, { ...resumed.broker!.storeIdentity, path: "relative" }, { ...resumed.broker!.storeIdentity, extra: true }]) {
  writeFileSync(path, JSON.stringify({ ...resumed, broker: { ...resumed.broker, storeIdentity: invalid } }), { mode: 0o600 });
  let refused = false;
  try { readStackJournal(root); } catch { refused = true; }
  suite.check("malformed persisted store identity is refused", refused);
}
writeFileSync(path, bytes, { mode: 0o600 });
console.log(`Retained filesystem fixture: ${root}`);
suite.finish();
