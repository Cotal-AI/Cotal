import { unlinkFileNoFollow, writeSecretFileAtomic } from "@cotal-ai/core";
import { canonicalLocalProcessPath, MANAGER_NAME_RECORD, protectedLocalDirectory, readLocalRecordSource, readManagerName, recordManagerName, type LocalProcessContext } from "@cotal-ai/workspace";

/** Give a new manager the name it reads at launch. A failed launch leaves the prior record intact. */
export async function withManagerName<T>(target: LocalProcessContext, name: string | undefined, start: () => Promise<T>): Promise<T> {
  if (name === undefined || name === readManagerName(target)) return start();
  const path = canonicalLocalProcessPath(MANAGER_NAME_RECORD, target);
  protectedLocalDirectory({ parentOf: path }, "the manager name record");
  const previous = readLocalRecordSource(path, 4096, true);
  recordManagerName(target, name);
  try {
    return await start();
  } catch (error) {
    protectedLocalDirectory({ parentOf: path }, "the manager name record");
    if (readManagerName(target) === name) {
      if (previous === undefined) unlinkFileNoFollow(path);
      else writeSecretFileAtomic(path, previous);
    }
    throw error;
  }
}
