/**
 * THE ONE WRITE ROUTE READ AS MUCH AS THE CALLER CARED TO SEND.
 *
 * `POST /api/channel/delete` is the dashboard's only write path. It read its body by pushing every
 * chunk into an array and concatenating, with no cap and no look at `content-length`, so the
 * ceiling on a request was the process heap.
 *
 * MEASURED against the shipped route on a local broker before this existed, with a raw socket
 * rather than `fetch`, because `fetch` hides how much of the body actually left the client and
 * that is half the question:
 *
 *   30,000,000 bytes posted   ALL 30,000,000 sent, 70,000,144 bytes of refusal returned,
 *                             peak RSS +1.39 GB, 1022 ms.
 *
 * The read ran to completion before the route formed any opinion, so the refusal was the expensive
 * part rather than the cheap one, and the amplification rode on top: a refusal echoes the name it
 * refuses, and an escaped U+2028 leaves as seven bytes for the three that arrived.
 *
 * WHAT THE CAP HAS TO BE, and why each half is here rather than only the obvious one:
 *
 *   refuse AT the threshold        not after reading to the end and then complaining, or the
 *                                  memory is already spent when the refusal is written.
 *   never truncate to the cap      a shortened channel name is a name the caller did not send,
 *                                  which is the aliasing shape the validator on this same route
 *                                  exists to refuse (Cotal #711). A cap that truncates would
 *                                  reintroduce it through the back door.
 *   stay a ceiling, not a trigger  an ordinary delete, and a padded one nowhere near the cap,
 *                                  must be untouched.
 *
 * WHAT THIS SUITE DOES NOT CLAIM. It does not claim the caller always READS the 413. It cannot: a
 * server that cuts a caller off mid-upload leaves unread bytes in the socket, that close goes out
 * as an RST, and an RST makes the peer drop the response it had already buffered. Measured over
 * equal arms of 200 posts of 30 MB, 144/200 callers read it without the drain in the request frame
 * and 176/200 with it. Better, not solved, and not assertable. The refusal that is never lost is
 * the OPERATOR LINE, which is written before the response is, and that is what cell 3.3 pins.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:web-body-cap
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { isReachable, setupSpaceStreams, CotalEndpoint, newIdentity } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async (): Promise<number> => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
});

/** The cap the route ships with. Typed here rather than imported so that moving the constant in
 *  the source cannot silently move what this suite checks along with it. */
const CAP = 8 * 1024;
const SMALL = "keep_me";      // deleted through the ordinary path, proves the route still works
const PADDED = "padded_me";   // deleted through a body just under the cap
const PREFIX = "prefix_me";   // named in the first bytes of an OVERSIZED body; must survive
const MSG = "seeded";

const PORT = await freePort();
const SPACE = "bodycap";
const SERVER = `nats://127.0.0.1:${PORT}`;
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
let webChild: ReturnType<typeof spawn> | undefined;
try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const seed = new CotalEndpoint({ space: SPACE, servers: SERVER, channels: [SMALL, PADDED, PREFIX],
    consume: false, registerPresence: false,
    card: { id: newIdentity().id, name: "seed", kind: "endpoint" } });
  seed.on("error", () => {});
  await seed.start();
  for (const ch of [SMALL, PADDED, PREFIX]) await seed.multicast(MSG, { channel: ch });
  await seed.stop();

  const WEB_PORT = await freePort();
  let log = "";
  webChild = spawn(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("./run-web.mts", import.meta.url)),
    "--server", SERVER, "--space", SPACE, "--port", String(WEB_PORT), "--no-open",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  webChild.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
  webChild.stderr?.on("data", (d: Buffer) => { log += d.toString(); });

  let served = false;
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/roster`).catch(() => undefined);
    if (r?.status === 200) { served = true; break; }
    await wait(250);
  }

  const post = async (payload: string): Promise<{ status: number; text: string }> => {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/channel/delete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: payload,
    });
    return { status: r.status, text: await r.text() };
  };
  const stillThere = async (ch: string): Promise<boolean> =>
    (await (await fetch(`http://127.0.0.1:${WEB_PORT}/api/channels/${ch}/history?limit=20`)).text()).includes(MSG);

  /** A raw socket, because the two facts that matter most here are how many bytes the CALLER got
   *  out before it was cut off, and whether a body with no `content-length` at all is still
   *  refused. `fetch` can express neither: it always declares a length and it never reports how
   *  much of the body it managed to write. */
  const raw = (head: string, body: Buffer, frame?: (b: Buffer) => Buffer): Promise<{ status: string; sent: number; text: string }> =>
    new Promise((resolve) => {
      let resp = "", sent = 0, settled = false;
      const sock = net.connect(WEB_PORT, "127.0.0.1", () => {
        sock.write(head);
        let off = 0;
        const pump = (): void => {
          while (off < body.length) {
            if (sock.destroyed) return;
            const end = Math.min(off + 65536, body.length);
            const piece = body.subarray(off, end);
            const okToWrite = sock.write(frame ? frame(piece) : piece);
            sent += end - off; off = end;
            if (!okToWrite) { sock.once("drain", pump); return; }
          }
          if (frame) sock.write("0\r\n\r\n");
        };
        pump();
      });
      sock.on("data", (d) => { resp += d.toString("latin1"); });
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve({ status: resp.split("\r\n")[0] ?? "", sent, text: resp.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
      };
      sock.on("error", done);
      sock.on("close", done);
      setTimeout(() => { sock.destroy(); done(); }, 25_000);
    });

  console.log("1. the ground truth this suite is about");
  ok("1.0 the shipped `web` entry point serves at all", served, log.slice(-300));
  ok("1.1 CONTROL: all three seeded channels hold their message, so every cell below is about the BODY and not about an empty broker",
    (await stillThere(SMALL)) && (await stillThere(PADDED)) && (await stillThere(PREFIX)));

  console.log("2. under the cap, nothing changed");
  {
    const r = await post(JSON.stringify({ channel: SMALL }));
    ok("2.1 an ordinary delete still purges, so the cap is a ceiling on the BODY and not a route that stopped working",
      r.status === 200 && r.text.includes('"purged"'), r);
    ok("2.2 ...and the message really is gone", !(await stillThere(SMALL)));
  }
  {
    // Deliberately close to the cap and deliberately under it. A cap that fires early would be
    // indistinguishable from a cap that fires correctly if every legitimate body were tiny.
    const pad = "a".repeat(CAP - 200);
    const payload = JSON.stringify({ channel: PADDED, pad });
    ok("2.3 CONTROL: the padded body really is under the cap, so 2.4 tests the ceiling and not the arithmetic in this file",
      Buffer.byteLength(payload) < CAP && Buffer.byteLength(payload) > CAP - 300, Buffer.byteLength(payload));
    const r = await post(payload);
    ok("2.4 a body just UNDER the cap is processed normally, extra fields and all",
      r.status === 200 && r.text.includes('"purged"'), r);
    ok("2.5 ...and it purged the channel it named", !(await stillThere(PADDED)));
  }
  {
    const r = await post(JSON.stringify({ channel: "abc.*" }));
    ok("2.6 CONTROL: a small body with a bad channel is still the OLD refusal, 400 and not 413, so the two refusals stay separate facts",
      r.status === 400, r);
  }

  console.log("3. over the cap, refused loudly");
  {
    const payload = JSON.stringify({ channel: PREFIX, pad: "a".repeat(CAP * 4) });
    const before = log.length;
    const r = await post(payload);
    ok("3.1 a body over the cap is refused with 413, the status for a body this server declined to READ, not the 400 it gives a body it read and disliked",
      r.status === 413, r);
    ok("3.2 ...and the refusal names the limit and the size that met it, so a caller learns what to change",
      r.text.includes(String(CAP)) && /\d{4,}/.test(r.text), r.text.slice(0, 200));
    await wait(200);
    const fresh = log.slice(before);
    ok("3.3 ...and the OPERATOR line records it as a refusal rather than a server fault: this is the one report that a reset connection cannot lose",
      fresh.includes("refused") && fresh.includes("request body") && !fresh.includes("failed:"),
      fresh.slice(-240));
  }

  console.log("4. never truncate to the cap");
  {
    // The first bytes of this body name a REAL channel that holds a message. An implementation
    // that capped by keeping the first CAP bytes would be holding a prefix of this, and the whole
    // point of the name check on this route is that a name the caller did not send must never
    // address a channel.
    const payload = JSON.stringify({ channel: PREFIX, pad: "a".repeat(CAP * 4) });
    ok("4.0 CONTROL: the channel this body names really is the first field, so a truncating cap would be holding a prefix that starts with it",
      payload.startsWith(`{"channel":"${PREFIX}"`), payload.slice(0, 40));
    const r = await post(payload);
    ok("4.1 the channel named in the first bytes of an oversized body is NOT purged: the body was declined, not shortened and acted on",
      await stillThere(PREFIX), r);
    ok("4.2 ...and the refusal is about the size, never a complaint about a channel name, which is what a truncated parse would produce",
      r.status === 413 && !r.text.includes("channel required") && !r.text.includes("is not a channel"), r);
  }

  console.log("5. the two gates, separately");
  {
    // Declared: refused before the body is read at all.
    const body = Buffer.alloc(20_000_000, 0x61);
    const head = "POST /api/channel/delete HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n" +
      `Connection: close\r\nContent-Length: ${body.length}\r\n\r\n`;
    const r = await raw(head, body);
    ok("5.1 a DECLARED oversize is refused, and the caller is cut off having sent a small fraction of what it announced, so the read never ran to the end",
      r.sent < body.length / 4, { sent: r.sent, declared: body.length, status: r.status });
  }
  const CHUNKED_HEAD = "POST /api/channel/delete HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n" +
    "Connection: close\r\nTransfer-Encoding: chunked\r\n\r\n";
  const asChunks = (b: Buffer): Buffer =>
    Buffer.concat([Buffer.from(b.length.toString(16) + "\r\n"), b, Buffer.from("\r\n")]);
  {
    // Chunked: there is no content-length to check, so only the streaming gate can refuse this.
    // Without that gate the header check alone would look like a cap and stop nothing.
    const r = await raw(CHUNKED_HEAD, Buffer.alloc(CAP * 8, 0x61), asChunks);
    ok("5.2 a body with NO declared length is still refused, so the cap is enforced on the bytes as they arrive and not only on what the caller admits to",
      r.status.includes("413"), { status: r.status, sent: r.sent, text: r.text.slice(0, 160) });
  }
  {
    // The same undeclared body, large enough that reading it to the end is visible from the
    // outside. A cap that counts correctly but only looks AFTER the loop answers 413 exactly like
    // this one and still spends the whole body first, so the status alone cannot tell them apart.
    // The caller being cut off is what separates them.
    const body = Buffer.alloc(20_000_000, 0x61);
    const r = await raw(CHUNKED_HEAD, body, asChunks);
    ok("5.3 ...and the caller is cut off partway through an undeclared body, so the refusal happened AT the threshold rather than after reading to the end",
      r.sent < body.length / 4, { sent: r.sent, total: body.length, status: r.status });
  }
} finally {
  webChild?.kill("SIGKILL");
  release();
  broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}

console.log(`web body cap: ${failed === 0 ? `${cells} cells OK` : `${failed} of ${cells} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
