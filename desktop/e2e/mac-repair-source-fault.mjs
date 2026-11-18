/** Change only the isolated fixture's retained plist, never the real protected repair intent. */
import assert from 'node:assert/strict';
import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';

export async function withChangedRepairSource({ file, expected, verifyAuthority, run, record }) {
  assert.equal(process.platform, 'darwin');
  const before = lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid(), 'source fault requires the isolated fixture-owned regular plist');
  assert.equal(readFileSync(file, 'utf8'), expected);
  verifyAuthority();
  const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
  const fault = `${expected}\n<!-- fixture-owned changed repair source -->\n`;
  let changed = false;
  const sameFile = () => {
    const held = fstatSync(fd), current = lstatSync(file);
    for (const value of [held, current]) {
      assert(value.isFile() && value.nlink === 1 && value.uid === before.uid);
      assert.equal(value.dev, before.dev);
      assert.equal(value.ino, before.ino, 'never overwrite a replacement source while restoring fixture bytes');
      assert.equal(value.mode, before.mode);
    }
  };
  const write = text => {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      assert(written > 0);
      offset += written;
    }
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  };
  try {
    sameFile();
    assert.equal(readFileSync(fd, 'utf8'), expected);
    // All actual repair children have exited. No other fixture operation may run until run returns.
    changed = true;
    write(fault);
    sameFile();
    assert.equal(readFileSync(file, 'utf8'), fault);
    record({ event: 'fixture-source-fault-installed', dev: before.dev, ino: before.ino });
    return await run(fault);
  } finally {
    try {
      if (changed) {
        sameFile();
        verifyAuthority();
        // A failed/partial write is not guessed into cleanup authority.
        assert.equal(readFileSync(file, 'utf8'), fault, 'changed source no longer equals the exact fixture fault; leave it untouched and fail');
        sameFile();
        write(expected);
        sameFile();
        assert.equal(readFileSync(file, 'utf8'), expected);
        record({ event: 'fixture-source-fault-restored', dev: before.dev, ino: before.ino });
      }
    } catch (error) {
      record({ event: 'fixture-source-restore-unconfirmed', dev: before.dev, ino: before.ino, error: error.message });
      throw error;
    } finally { closeSync(fd); }
  }
}
