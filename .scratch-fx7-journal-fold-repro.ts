import { appendFileSync, mkdtempSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JcodeJournalSource } from "./extensions/connector-jcode/src/agui-source.ts";

const root = mkdtempSync(join(process.cwd(), ".fx7-repro-"));
const journal = join(root, "session.journal.jsonl");
const records = [
  { append_messages: [{ role: "assistant", content: [{ type: "text", text: "one" }] }] },
  { append_messages: [{ role: "assistant", content: [{ type: "text", text: "two" }] }] },
  { append_messages: [{ role: "assistant", content: [{ type: "text", text: "three" }] }] },
];
const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");

async function reproduce(kind: "truncate" | "unlink-recreate"): Promise<void> {
  writeFileSync(journal, body);
  const source = new JcodeJournalSource(journal);
  const initial = await source.read(undefined);
  const read = await source.read(initial.cursor);
  console.log(`${kind}: initial=${initial.records.length}, read=${read.records.length}`);
  if (kind === "truncate") truncateSync(journal, 0);
  else {
    unlinkSync(journal);
    writeFileSync(journal, `${JSON.stringify(records[0])}\n`);
  }
  try {
    await source.read(read.cursor);
    console.log(`${kind}: unexpectedly read after fold`);
  } catch (error) {
    console.log(`${kind}: ${(error as Error).message}`);
  }
}

try {
  await reproduce("truncate");
  await reproduce("unlink-recreate");
} finally {
  rmSync(root, { recursive: true, force: true });
}
