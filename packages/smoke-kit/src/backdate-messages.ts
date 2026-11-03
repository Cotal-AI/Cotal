/**
 * Backdate messages in a STOPPED broker's file store, so a suite can hold messages older than the
 * broker it runs on.
 *
 * The broker stamps a message with its own clock. nats-server is a Go binary, which reads that clock
 * through the vDSO where no LD_PRELOAD shim reaches it, and it refuses a client publish whose reply
 * starts with `$JS.ACK`, which is the only way a mirror takes a timestamp it is given. So this edits
 * the store on disk: it rewrites the timestamp of chosen sequences in a stream's message blocks,
 * writes each changed record's checksum again, and removes the stream state file, so the broker
 * rebuilds the state from the blocks when it starts.
 *
 * Layout, from nats-server's `filestore.go`: a block `<n>.blk` is a run of records
 * `total_len(4) seq(8) ts(8) subj_len(2) subj [hdr_len(4) hdr] msg hash(8)`, little endian, with the
 * high bit of `total_len` set when headers are present. `hash` is HighwayHash-64 of `seq ts subj
 * [hdr] msg` keyed by SHA-256 of `<stream>-<n>`. A record whose hash does not match is dropped with
 * every record after it, so a suite can tell a wrong rewrite from a right one by reading the messages
 * back. An encrypted or compressed store is not supported.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HBIT = 0x80000000;
const EBIT = 1n << 63n;
const RECORD_HEADER = 22;
const RECORD_HASH = 8;

/** The `msgs` directory of `stream` under a JetStream store directory, for whichever account holds it. */
export function streamMsgsDir(storeDir: string, stream: string): string {
  const js = join(storeDir, "jetstream");
  const found = readdirSync(js).map((account) => join(js, account, "streams", stream, "msgs")).filter((dir) => existsSync(dir));
  if (found.length !== 1) throw new Error(`expected one ${stream} under ${js}, found ${found.length}`);
  return found[0]!;
}

/**
 * Set the timestamp of each sequence in `ages` to `now - age` milliseconds, in every block of the
 * stream whose `msgs` directory is `msgsDir`. The broker must be stopped. Returns the sequences it
 * rewrote, so a caller can check that every one it asked for was found.
 */
export function backdateMessages(msgsDir: string, stream: string, ages: ReadonlyMap<number, number>, now = Date.now()): number[] {
  const done: number[] = [];
  for (const file of readdirSync(msgsDir).filter((name) => /^\d+\.blk$/.test(name))) {
    const key = createHash("sha256").update(`${stream}-${Number.parseInt(file, 10)}`).digest();
    const path = join(msgsDir, file);
    const buf = readFileSync(path);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let off = 0; off < buf.length;) {
      const word = view.getUint32(off, true);
      const length = (word & ~HBIT) >>> 0;
      if (length < RECORD_HEADER + RECORD_HASH || off + length > buf.length) throw new Error(`${path}: the record at byte ${off} has length ${length}`);
      const seq = view.getBigUint64(off + 4, true);
      const age = (seq & EBIT) === 0n ? ages.get(Number(seq)) : undefined;
      if (age !== undefined) {
        view.setBigUint64(off + 12, BigInt(now - age) * 1_000_000n, true);
        const subjectLength = view.getUint16(off + 20, true);
        const data = buf.subarray(off + RECORD_HEADER, off + length - RECORD_HASH);
        // The header length word is not hashed; the headers themselves are.
        const body = (word & HBIT) !== 0 ? data.subarray(subjectLength + 4) : data.subarray(subjectLength);
        buf.set(highwayHash64(key, Buffer.concat([buf.subarray(off + 4, off + 20), data.subarray(0, subjectLength), body])), off + length - RECORD_HASH);
        done.push(Number(seq));
      }
      off += length;
    }
    writeFileSync(path, buf);
  }
  rmSync(join(msgsDir, "index.db"), { force: true });
  return done.sort((a, b) => a - b);
}

// HighwayHash-64, ported from github.com/minio/highwayhash v1.0.4 (`highwayhash.go`,
// `highwayhash_generic.go`), the module nats-server uses for these checksums.
const MASK = (1n << 64n) - 1n;
const INIT0 = [0xdbe6d5d5fe4cce2fn, 0xa4093822299f31d0n, 0x13198a2e03707344n, 0x243f6a8885a308d3n];
const INIT1 = [0x3bd39e10cb0ef593n, 0xc0acf169b5f18a8cn, 0xbe5466cf34e90c6cn, 0x452821e638d01377n];
const V0 = 0, V1 = 4, MUL0 = 8, MUL1 = 12;

const swapHalves = (x: bigint): bigint => ((x >> 32n) | (x << 32n)) & MASK;
const u64 = (b: Uint8Array, at: number): bigint => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);

function zipperMerge(s: bigint[], from: number, to: number): void {
  const a = s[from]!, b = s[from + 1]!;
  let res = a & (0xffn << 16n);
  let res2 = (a & (0xffn << 56n)) + (b & (0xffn << 16n));
  res += (b & (0xffn << 56n)) >> 8n;
  res2 += (a & (0xffn << 48n)) >> 8n;
  res += ((a & (0xffn << 40n)) + (b & (0xffn << 48n))) >> 16n;
  res2 += (b & (0xffn << 40n)) >> 16n;
  res += ((a & (0xffn << 24n)) + (b & (0xffn << 32n))) >> 24n;
  res2 += ((b & (0xffn << 24n)) + (a & (0xffn << 32n))) >> 24n;
  res += ((a & (0xffn << 8n)) << 32n) & MASK;
  res2 += ((b & 0xffn) << 48n) & MASK;
  res += (a << 56n) & MASK;
  res2 += ((b & (0xffn << 8n)) << 24n) & MASK;
  s[to] = (s[to]! + res) & MASK;
  s[to + 1] = (s[to + 1]! + res2) & MASK;
}

function update(s: bigint[], packets: Uint8Array): void {
  for (let off = 0; off + 32 <= packets.length; off += 32) {
    for (let i = 0; i < 4; i++) {
      s[V1 + i] = (s[V1 + i]! + u64(packets, off + 8 * i) + s[MUL0 + i]!) & MASK;
      s[MUL0 + i] = s[MUL0 + i]! ^ (((s[V1 + i]! & 0xffffffffn) * (s[V0 + i]! >> 32n)) & MASK);
      s[V0 + i] = (s[V0 + i]! + s[MUL1 + i]!) & MASK;
      s[MUL1 + i] = s[MUL1 + i]! ^ (((s[V0 + i]! & 0xffffffffn) * (s[V1 + i]! >> 32n)) & MASK);
    }
    zipperMerge(s, V1, V0);
    zipperMerge(s, V1 + 2, V0 + 2);
    zipperMerge(s, V0, V1);
    zipperMerge(s, V0 + 2, V1 + 2);
  }
}

/** The last partial packet of 1 to 31 bytes, as `hashBuffer` folds it in. */
function updateRemainder(s: bigint[], buffer: Uint8Array, size: number): void {
  const block = new Uint8Array(32);
  const sizes = (BigInt(size) << 32n) + BigInt(size);
  for (let i = 0; i < 4; i++) s[V0 + i] = (s[V0 + i]! + sizes) & MASK;
  const rotate = (half: number): number => ((half << size) | (half >>> (32 - size))) >>> 0;
  for (let i = 0; i < 4; i++) {
    const low = rotate(Number(s[V1 + i]! & 0xffffffffn)), high = rotate(Number(s[V1 + i]! >> 32n));
    s[V1 + i] = (BigInt(high) << 32n) | BigInt(low);
  }
  const mod4 = size & 3, whole = size - mod4;
  block.set(buffer.subarray(0, whole));
  if (size >= 16) block.set(buffer.subarray(size - 4, size), 28);
  else if (mod4 !== 0) new DataView(block.buffer).setUint32(16, buffer[whole]! + (buffer[whole + (mod4 >> 1)]! << 8) + (buffer[size - 1]! << 16), true);
  update(s, block);
}

/** HighwayHash-64 of `data` under a 32-byte `key`, as the 8 little-endian bytes Go's `Sum` appends. */
export function highwayHash64(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error("highwayhash: the key must be 32 bytes");
  const s: bigint[] = new Array<bigint>(16).fill(0n);
  for (let i = 0; i < 4; i++) {
    const k = u64(key, 8 * i);
    s[MUL0 + i] = INIT0[i]!;
    s[MUL1 + i] = INIT1[i]!;
    s[V0 + i] = INIT0[i]! ^ k;
    s[V1 + i] = INIT1[i]! ^ swapHalves(k);
  }
  const whole = data.length & ~31;
  update(s, data.subarray(0, whole));
  if (data.length > whole) {
    const buffer = new Uint8Array(32);
    buffer.set(data.subarray(whole));
    updateRemainder(s, buffer, data.length - whole);
  }
  for (let round = 0; round < 4; round++) {
    const permuted = new Uint8Array(32), view = new DataView(permuted.buffer);
    [s[V0 + 2]!, s[V0 + 3]!, s[V0]!, s[V0 + 1]!].forEach((lane, i) => view.setBigUint64(8 * i, swapHalves(lane), true));
    update(s, permuted);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, (s[V0]! + s[V1]! + s[MUL0]! + s[MUL1]!) & MASK, true);
  return out;
}
