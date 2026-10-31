import { closeSync, constants, copyFileSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export const CURSOR_DATABASE_FILES = [
  ".config/Cursor/User/globalStorage/state.vscdb",
  ".config/cursor/User/globalStorage/state.vscdb",
  "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  "Library/Application Support/cursor/User/globalStorage/state.vscdb",
  "AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
  "AppData/Roaming/cursor/User/globalStorage/state.vscdb",
];

/** Keep the three values Jcode's native Cursor reader consumes, without copying editor state.
 * SQLite reads committed WAL content too. Publication still uses the caller's pinned parent:
 * SQLite writes only in a fresh private staging directory, never through that destination path. */
export function copyCursorCredentials(source: string, destination: string): void {
  const input = new DatabaseSync(source, { readOnly: true });
  let rows: Record<string, SQLOutputValue>[];
  try {
    rows = input.prepare("SELECT key, value FROM ItemTable WHERE key IN (?, ?, ?)").all(
      "cursorAuth/accessToken", "cursorAuth/refreshToken", "storage.serviceMachineId",
    );
  } finally { input.close(); }

  const stage = mkdtempSync(join(tmpdir(), "cotal-jcode-cursor-"));
  try {
    const path = join(stage, "auth.sqlite");
    closeSync(openSync(path, "wx", 0o600));
    const output = new DatabaseSync(path);
    try {
      output.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
      const insert = output.prepare("INSERT INTO ItemTable VALUES (?, ?)");
      for (const row of rows) insert.run(row.key!, row.value!);
    } finally { output.close(); }
    copyFileSync(path, destination, constants.COPYFILE_EXCL);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
