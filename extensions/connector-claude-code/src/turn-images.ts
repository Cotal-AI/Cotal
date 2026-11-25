/**
 * A turn's images, as files Claude Code reads. A plugin's prompt carries text only, and Claude Code
 * expands no `@file` mention in it, so each image is written to the seat's image folder and the
 * prompt names its path for the model to read.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnImage } from "@cotal-ai/core";

/** Names the seat's image folder: made private by the launch, which removes it once the seat ends. */
export const TURN_IMAGES_ENV = "COTAL_CLAUDE_TURN_IMAGES";

const EXTENSION: Record<TurnImage["mimeType"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Make the seat's image folder as a launch artifact, which the launcher removes once the seat has
 *  exited. Returns the env that names it, and the `claude` flags that let the model read it without
 *  asking: in a mode that asks, a Read outside the project opens a permission prompt. None on
 *  Windows, where the seat serves no commands. */
export function imageFolder(artifacts: string[]): { env: Record<string, string>; args: string[] } {
  if (process.platform === "win32") return { env: {}, args: [] };
  const dir = mkdtempSync(join(tmpdir(), `cotal-claude-images-${randomBytes(16).toString("hex")}-`));
  artifacts.push(dir);
  // A permission rule names an absolute path with a leading `//`.
  return { env: { [TURN_IMAGES_ENV]: dir }, args: ["--allowedTools", `Read(/${dir}/**)`] };
}

function assertPrivate(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0) throw new Error(`${dir} is not a private directory of this user's`);
}

/** Write each image to a new 0600 file in `dir`, and return `text` followed by a line naming each. */
export function promptWithImages(dir: string, text: string, images: readonly TurnImage[]): string {
  assertPrivate(dir);
  const stem = randomBytes(8).toString("hex");
  const named = images.map((image, i) => {
    const path = join(dir, `${stem}-${i + 1}.${EXTENSION[image.mimeType]}`);
    writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600, flag: "wx" });
    return `[Image ${i + 1}: ${path}]`;
  });
  return [...(text ? [text] : []), ...named].join("\n\n");
}
