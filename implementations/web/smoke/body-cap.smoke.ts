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
 * as an RST, and an RST makes the peer drop the response it had already buffered. The refusal that
 * is never lost is the OPERATOR LINE, which is written before the response is, and that is what
 * cell 3.3 pins.
 *
 * Section 9: the GATE's refusal closes an announced upload too, so a stranger with no session
 * cannot hold the dashboard reading one (#2024); a bodyless refusal keeps its connection.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:web-body-cap
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { isReachable, setupSpaceStreams, CotalEndpoint, newIdentity } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The cap the route ships with. Typed here rather than imported so that moving the constant in
 *  the source cannot silently move what this suite checks along with it. */
const CAP = 8 * 1024;
const SMALL = "keep_me";      // deleted through the ordinary path, proves the route still works
const PADDED = "padded_me";   // deleted through a body just under the cap
const PREFIX = "prefix_me";   // named in the first bytes of an OVERSIZED body; must survive
const EDGE_CL = "edge_cl";    // deleted through a body of EXACTLY the cap, with a declared length
const EDGE_TE = "edge_te";    // the same, with no declared length at all
const KEEP_A = "keep_a";      // deleted over a keep-alive socket, first request
const KEEP_B = "keep_b";      // deleted over the SAME socket, proving it stayed reusable
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

  const seed = new CotalEndpoint({ space: SPACE, servers: SERVER, channels: [SMALL, PADDED, PREFIX, EDGE_CL, EDGE_TE, KEEP_A, KEEP_B],
    consume: false, registerPresence: false,
    card: { id: newIdentity().id, name: "seed", kind: "endpoint" } });
  seed.on("error", () => {});
  await seed.start();
  for (const ch of [SMALL, PADDED, PREFIX, EDGE_CL, EDGE_TE, KEEP_A, KEEP_B]) await seed.multicast(MSG, { channel: ch });
  await seed.stop();

  const WEB_PORT = await freePort();
  let log = "";
  webChild = spawn(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("./run-web.mts", import.meta.url)),
    "--server", SERVER, "--space", SPACE, "--port", String(WEB_PORT), "--no-open",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  webChild.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
  webChild.stderr?.on("data", (d: Buffer) => { log += d.toString(); });

  let launchUrl: string | undefined;
  for (let i = 0; i < 200 && launchUrl === undefined; i++) {
    launchUrl = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+/)?.[0];
    await wait(250);
  }
  const exchange = launchUrl === undefined ? undefined : await fetch(launchUrl, { redirect: "manual" }).catch(() => undefined);
  const session = /(?:^|,\s*)cotal_web_session=([^;]+)/.exec(exchange?.headers.get("set-cookie") ?? "")?.[1];
  const authed = { cookie: `cotal_web_session=${session}` };
  const ready = session === undefined ? undefined
    : await fetch(`http://127.0.0.1:${WEB_PORT}/api/roster`, { headers: authed }).catch(() => undefined);
  const served = exchange?.status === 302 && session !== undefined && ready?.status === 200;

  const post = async (payload: string): Promise<{ status: number; text: string }> => {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/channel/delete`, {
      method: "POST", headers: { ...authed, "content-type": "application/json" }, body: payload,
    });
    return { status: r.status, text: await r.text() };
  };
  const stillThere = async (ch: string): Promise<boolean> =>
    (await (await fetch(`http://127.0.0.1:${WEB_PORT}/api/channels/${ch}/history?limit=20`, { headers: authed })).text()).includes(MSG);

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

  const COOKIE = `Cookie: ${authed.cookie}\r\n`;
  const CHUNKED_HEAD = "POST /api/channel/delete HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n" + COOKIE +
    "Connection: close\r\nTransfer-Encoding: chunked\r\n\r\n";
  const asChunks = (b: Buffer): Buffer =>
    Buffer.concat([Buffer.from(b.length.toString(16) + "\r\n"), b, Buffer.from("\r\n")]);

  console.log("1. the ground truth this suite is about");
  ok("1.0 the shipped `web` entry point serves at all", served, log.slice(-300));
  ok("1.1 CONTROL: every seeded channel holds its message, so every cell below is about the BODY and not about an empty broker",
    (await stillThere(SMALL)) && (await stillThere(PADDED)) && (await stillThere(PREFIX))
    && (await stillThere(EDGE_CL)) && (await stillThere(EDGE_TE))
    && (await stillThere(KEEP_A)) && (await stillThere(KEEP_B)));

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
    // SENT WITHOUT A DECLARED LENGTH ON PURPOSE. With a `content-length` the header gate answers
    // first and the body is never read at all, so a cap that truncates while reading would sail
    // through this section looking correct. Chunked forces the reading path, which is the only
    // place truncation could happen.
    const payload = JSON.stringify({ channel: PREFIX, pad: "a".repeat(CAP * 4) });
    ok("4.0 CONTROL: the channel this body names really is the first field, so a truncating cap would be holding a prefix that starts with it",
      payload.startsWith(`{"channel":"${PREFIX}"`), payload.slice(0, 40));
    const r = await raw(CHUNKED_HEAD, Buffer.from(payload, "utf8"), asChunks);
    ok("4.1 the channel named in the first bytes of an oversized body is NOT purged: the body was declined, not shortened and acted on",
      await stillThere(PREFIX), r);
    ok("4.2 ...and the refusal is about the size, never a complaint about a channel name, which is what a truncated parse would produce",
      r.status.includes("413") && !r.text.includes("channel required") && !r.text.includes("is not a channel"), r);
  }

  console.log("5. the two gates, separately");
  {
    // ONLY THE HEADER GATE CAN ANSWER THIS. The caller announces a body far over the cap and then
    // sends a few bytes and stops. The streaming count never reaches the cap, so a server that
    // only counts what arrives waits for bytes that are not coming, and the caller learns nothing
    // until something else times out. Refusing on the announcement is the difference.
    const head = "POST /api/channel/delete HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n" + COOKIE +
      `Connection: close\r\nContent-Length: ${20_000_000}\r\n\r\n`;
    const r = await raw(head, Buffer.from('{"channel":"a', "utf8"));
    ok("5.0 a body ANNOUNCED as oversized is refused on the announcement, without waiting for bytes the caller never sends",
      r.status.includes("413"), { status: r.status, sent: r.sent, text: r.text.slice(0, 160) });
  }
  {
    // Declared: refused before the body is read at all.
    const body = Buffer.alloc(20_000_000, 0x61);
    const head = "POST /api/channel/delete HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n" + COOKIE +
      `Connection: close\r\nContent-Length: ${body.length}\r\n\r\n`;
    const r = await raw(head, body);
    ok("5.1 a DECLARED oversize is refused and the caller never finishes the body it announced, so the read did not run to the end",
      r.sent < body.length, { sent: r.sent, declared: body.length, status: r.status });
  }
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
    //
    // AGAINST THE FULL LENGTH, NOT A FRACTION OF IT. This asserted `sent < body.length / 4` until
    // the quarter was measured rather than assumed: five runs of this shape gave a worst case of
    // 3,211,264 against a bar of 5,000,000, a margin of 1.56x that moved by 3x run to run on an
    // idle machine. That is a race with however fast a box drains a loopback socket, and a faster
    // runner reds the cell for a reason that has nothing to do with the code. The strict inequality
    // against the whole body is the event the cell is named for, it cannot flake, because once the
    // server stops reading the caller is bounded by the socket buffer rather than by a race, and it
    // still separates the two implementations: a cap that reads to the end lets the caller finish.
    const body = Buffer.alloc(20_000_000, 0x61);
    const r = await raw(CHUNKED_HEAD, body, asChunks);
    ok("5.3 ...and the caller is cut off partway through an undeclared body, so the refusal happened AT the threshold rather than after reading to the end",
      r.sent < body.length, { sent: r.sent, total: body.length, status: r.status });
  }

  console.log("6. the threshold itself, one byte on each side of it");
  {
    // THE CAP IS A NUMBER AND A COMPARISON, and section 2 pins CAP-200 while sections 3 to 5 pin
    // CAP*4 and larger. Every one of those survives an off-by-one: turning `>` into `>=` at either
    // gate refuses a body of exactly the cap, which is a legitimate request, and nothing above
    // notices. So the boundary is asserted here on BOTH gates, since they compare different
    // numbers: the header gate compares what the caller declared, the read loop compares what has
    // arrived, and an off-by-one in one is invisible to the other.
    const exact = (channel: string, n: number): string => {
      const head = `{"channel":"${channel}","pad":"`;
      const body = head + "a".repeat(n - head.length - 2) + '"}';
      if (Buffer.byteLength(body) !== n) throw new Error(`built ${Buffer.byteLength(body)} bytes, wanted ${n}`);
      return body;
    };
    const atCap = exact(EDGE_CL, CAP), overCap = exact(PREFIX, CAP + 1), atCapTe = exact(EDGE_TE, CAP);
    ok("6.0 CONTROL: the bodies below really are the cap and one byte past it, so this section tests the comparison and not the arithmetic in this file",
      Buffer.byteLength(atCap) === CAP && Buffer.byteLength(overCap) === CAP + 1 && Buffer.byteLength(atCapTe) === CAP,
      [Buffer.byteLength(atCap), Buffer.byteLength(overCap)]);

    const r1 = await post(atCap);
    ok("6.1 a body of EXACTLY the cap is accepted and purges: the limit is a ceiling the caller may reach, not one it must stay under",
      r1.status === 200 && !(await stillThere(EDGE_CL)), r1);

    const r2 = await post(overCap);
    ok("6.2 ...and ONE byte more is refused, so the declared-length gate turns over between CAP and CAP+1 and not somewhere either side of it",
      r2.status === 413, r2);

    const r3 = await raw(CHUNKED_HEAD, Buffer.from(atCapTe, "utf8"), asChunks);
    ok("6.3 the same body with NO declared length is accepted too, which is the read loop's own boundary rather than the header gate's",
      r3.status.includes("200") && !(await stillThere(EDGE_TE)), { status: r3.status, text: r3.text.slice(0, 160) });

    const r4 = await raw(CHUNKED_HEAD, Buffer.from(exact(PREFIX, CAP + 1), "utf8"), asChunks);
    ok("6.4 ...and one byte past it is refused on the read loop as well, with the channel it names untouched",
      r4.status.includes("413") && (await stillThere(PREFIX)), { status: r4.status, text: r4.text.slice(0, 160) });
  }

  console.log("7. routes that do not read bodies refuse them on the announcement");
  {
    // The other dashboard routes never inspect `req`, so they have a zero-byte policy rather than
    // the delete route's 8 KiB policy. These are raw sockets because a fetch body hides whether the
    // server closed early and cannot express transfer-encoding without a declared length.
    const NO_BODY = Buffer.alloc(20_000_000, 0x61);
    const noBodyHead = (path: string, headers: string): string =>
      `POST ${path} HTTP/1.1\r\nHost: h\r\n${COOKIE}Connection: keep-alive\r\n${headers}\r\n`;

    const declared = await raw(noBodyHead("/api/roster", `Content-Length: ${NO_BODY.length}\r\n`), Buffer.alloc(0));
    ok("7.0 an announced 20 MB body to a no-body route is refused at its zero-byte limit before it can be accepted",
      declared.status.includes("413") && declared.text.includes("/api/roster") && declared.text.includes("takes no request body"),
      { status: declared.status, text: declared.text.slice(0, 180) });

    const beforeDeclared = log.length;
    const cutOff = await raw(noBodyHead("/api/roster", `Content-Length: ${NO_BODY.length}\r\n`), NO_BODY);
    await wait(200);
    const declaredLog = log.slice(beforeDeclared);
    ok("7.1 ...and a caller sending that announced body is cut off before it finishes while the operator records a refusal rather than a server fault",
      cutOff.sent < NO_BODY.length
      && declaredLog.includes("refused") && declaredLog.includes("/api/roster") && declaredLog.includes("takes no request body")
      && !declaredLog.includes("failed:"),
      { sent: cutOff.sent, total: NO_BODY.length, operatorLine: declaredLog.slice(-240) });

    const beforeChunked = log.length;
    const chunked = await raw(noBodyHead("/api/roster", "Transfer-Encoding: chunked\r\n"), NO_BODY, asChunks);
    await wait(200);
    const chunkedLog = log.slice(beforeChunked);
    ok("7.2 transfer-encoding on a no-body route is refused on that framing announcement without reading the chunked body",
      chunked.sent < NO_BODY.length && /takes no request body/.test(chunkedLog),
      { sent: chunked.sent, total: NO_BODY.length, status: chunked.status, operatorLine: chunkedLog.slice(-240) });

    const channels = await raw(noBodyHead("/api/channels", `Content-Length: ${NO_BODY.length}\r\n`), Buffer.alloc(0));
    ok("7.3 the same zero-byte guard covers a second no-body route rather than special-casing the roster",
      channels.status.includes("413") && channels.text.includes("/api/channels"),
      { status: channels.status, text: channels.text.slice(0, 180) });

    const get = await fetch(`http://127.0.0.1:${WEB_PORT}/api/roster`, { headers: authed });
    ok("7.4 CONTROL: a bodyless GET to the roster is still served normally",
      get.status === 200, { status: get.status, text: await get.text() });
    const zero = await raw(noBodyHead("/api/roster", "Content-Length: 0\r\n"), Buffer.alloc(0));
    ok("7.5 CONTROL: an explicit content-length of zero is not a body and reaches the route normally",
      zero.status.includes("200"), { status: zero.status, text: zero.text.slice(0, 160) });
  }

  console.log("8. the bound does not depend on a header the CALLER chooses");
  {
    // EVERY CELL ABOVE SENDS `Connection: close`, which is the arm where this cap looks perfect:
    // the frame's reply closes the socket under a caller that is still uploading. On a keep-alive
    // connection Node wants the socket back and reads the rest of the body to get it, so before
    // the refusal carried `connection: close` a caller got to send all 30,000,000 bytes and the
    // server spent six seconds reading them, with the 413 already on the wire at 2 ms. A bound a
    // caller can lift by choosing a header is not a bound, and no cell above could see it because
    // they all chose the header for it.
    //
    // BOTH GATES, SEPARATELY, because they end the request by different mechanisms and the refusal
    // header is written after that has already happened. Throwing on the declared length leaves the
    // request object intact; throwing out of the read loop abandons the iterator, which DESTROYS
    // the request. A close header written onto an already-destroyed request is exactly the case
    // where the other gate's result is worth nothing, so neither cell stands for the other.
    //
    // ASSERTED AS EVENTS, NOT AS A RATE. "How many bytes got through" is a race with however fast
    // this machine drains a loopback socket, and a threshold on it is a cell that passes or fails
    // for reasons that have nothing to do with the code. Each check below either happened or did
    // not. The termination check is a CONTROL on the header being honoured rather than merely
    // printed: it is satisfied eventually even without the fix, because the platform gives up on
    // the promised body on its own at around 6003 ms. The header is what discriminates, and the
    // measured 3 ms against 6003 ms is supporting evidence recorded here rather than an oracle.
    //
    // THE TWO ARMS ASSERT DIFFERENT THINGS, and that asymmetry is measured rather than tidied
    // away. The declared arm sends NO body bytes, so the server has nothing unread when it closes
    // and the caller reliably reads the 413. The chunked arm is mid-upload by construction, which
    // leaves unread bytes, which makes the close an RST, which makes the caller discard a response
    // it may already have buffered: a first version of the chunked cell asserted the 413 text and
    // FAILED with an empty response on a run where the declared arm passed. That is this change's
    // own stated limit arriving in its own suite, so the chunked cell asserts what the server owns
    // rather than what the caller receives: the connection ended, the upload was cut off, and the
    // OPERATOR line recorded the refusal.
    const KEEPALIVE = "Connection: keep-alive\r\n";
    ok("7.0 CONTROL: the requests below really do ask to KEEP the connection, so this section tests that header and not the close path every cell above uses",
      KEEPALIVE.includes("keep-alive") && !KEEPALIVE.includes("close"));

    const oversizedOverKeepAlive = async (declared: boolean): Promise<{ resp: string; closedAfterMs: number | null; afterClose: string; sent: number }> => {
      const head = "POST /api/channel/delete HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n" + COOKIE + KEEPALIVE +
        (declared ? "Content-Length: 20000000\r\n\r\n" : "Transfer-Encoding: chunked\r\n\r\n");
      let resp = "", sent = 0;
      const piece = Buffer.alloc(65536, 0x61);
      const sock = net.connect(WEB_PORT, "127.0.0.1", () => {
        sock.write(head);
        if (declared) return;   // no body at all: the DECLARED size is what refuses, and 5.0 already
                                // owns "refuses without waiting for the body". Sending nothing here
                                // keeps the close clean so this arm can assert the reply itself.
        const pump = (): void => {   // no declared length: only the reading gate can stop this
          while (sent < 20_000_000) {
            if (sock.destroyed) return;
            const okToWrite = sock.write(Buffer.concat([Buffer.from(piece.length.toString(16) + "\r\n"), piece, Buffer.from("\r\n")]));
            sent += piece.length;
            if (!okToWrite) { sock.once("drain", pump); return; }
          }
        };
        pump();
      });
      sock.on("data", (d) => { resp += d.toString("latin1"); });
      sock.on("error", () => {});
      const closedAfterMs = await new Promise<number | null>((resolve) => {
        const t0 = Date.now();
        sock.on("close", () => resolve(Date.now() - t0));
        setTimeout(() => resolve(null), 20_000);
      });
      const afterClose = await new Promise<string>((resolve) => {
        if (!sock.writable) return resolve("not writable");
        sock.write("b".repeat(1000), (e) => resolve(e ? `refused: ${(e as NodeJS.ErrnoException).code ?? e.message}` : "accepted"));
        setTimeout(() => resolve("no callback"), 3000);
      });
      return { resp, closedAfterMs, afterClose, sent };
    };

    const dec = await oversizedOverKeepAlive(true);
    ok("7.1 an oversized DECLARED body on a KEEP-ALIVE connection is refused and that connection ENDS, so the cap bounds what this server takes in rather than what the caller volunteers to stop sending",
      dec.resp.includes("413") && /connection:\s*close/i.test(dec.resp) && dec.closedAfterMs !== null,
      { status: dec.resp.split("\r\n")[0], closedAfterMs: dec.closedAfterMs, head: dec.resp.slice(0, 200) });
    ok("7.2 ...and body bytes written after that cannot be delivered, which is the difference between a connection that ended and a refusal the caller may ignore",
      dec.afterClose !== "accepted", dec.afterClose);

    const beforeChunked = log.length;
    const chk = await oversizedOverKeepAlive(false);
    await wait(300);
    const chunkedLog = log.slice(beforeChunked);
    ok("7.3 an oversized CHUNKED body over keep-alive is cut off and RECORDED BY THE OPERATOR even though the uploading caller may get no readable reply, which is the durable half of the refusal and the half this change actually owns",
      chk.closedAfterMs !== null && chk.sent < 20_000_000 && /8192 byte limit/.test(chunkedLog),
      { closedAfterMs: chk.closedAfterMs, sentOf20MB: chk.sent, replyBytesTheCallerGot: chk.resp.length,
        operatorLine: (chunkedLog.split("\n").find((l) => l.includes("8192 byte limit")) ?? "(none)").slice(0, 200) });
    ok("7.4 ...and body bytes written after THAT cannot be delivered either",
      chk.afterClose !== "accepted", chk.afterClose);
  }
  {
    // THE NEGATIVE ARM, and it is the reason the four cells above are not free. Refusing by closing
    // every connection would pass all of them by breaking the server for everyone, so an ordinary
    // within-cap request has to leave its socket usable, and the proof is a SECOND request served
    // on the SAME socket.
    const req = (ch: string): string => {
      const b = JSON.stringify({ channel: ch });
      return "POST /api/channel/delete HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n" + COOKIE +
        `Connection: keep-alive\r\nContent-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`;
    };
    let resp = "";
    const sock = net.connect(WEB_PORT, "127.0.0.1");
    sock.on("data", (d) => { resp += d.toString("latin1"); });
    sock.on("error", () => {});
    await new Promise<void>((r) => { sock.on("connect", () => r()); setTimeout(r, 5000); });
    sock.write(req(KEEP_A));
    for (let i = 0; i < 100 && !resp.includes("\r\n\r\n"); i++) await wait(100);
    const first = resp;
    ok("7.5 CONTROL: an ordinary within-cap delete over keep-alive is served, and its answer does NOT say the connection is closing",
      first.includes("200") && !/connection:\s*close/i.test(first), first.slice(0, 200));
    resp = "";
    const reusable = sock.writable && !sock.destroyed;
    if (reusable) sock.write(req(KEEP_B));
    for (let i = 0; i < 100 && !resp.includes("\r\n\r\n"); i++) await wait(100);
    ok("7.6 ...and a SECOND request is served on that same socket, so the remedy above ends the connection an oversized body was riding on and not keep-alive itself",
      reusable && resp.includes("200") && resp.includes('"purged"'), { reusable, second: resp.slice(0, 200) });
    sock.destroy();
  }

  console.log("9. the gate refuses an announced upload before reading it too");
  {
    // Sections 7 and 8 pin what a SESSION holder meets: the no-body guard refuses the announcement
    // and the catch closes the connection. The gate runs before that guard, so its refusal used to
    // leave a stranger uploading on a kept-alive socket that Node then drained to get back (#2024):
    // measured, all 20,000,000 announced bytes accepted after the 401. The remedy is the close
    // header on the gate's own refusal, and these cells assert it as EVENTS, NOT RATES, the way
    // section 8 explains: `sent < NO_BODY.length` is the strict inequality against the whole body,
    // which cannot flake, because once the server stops reading the caller is bounded by the
    // socket buffer rather than by a race.
    const strangerHead = (headers: string): string =>
      `POST /api/roster HTTP/1.1\r\nHost: h\r\nConnection: keep-alive\r\n${headers}\r\n`;
    const NO_BODY = Buffer.alloc(20_000_000, 0x61);

    // THE UPLOADING CALLER MAY READ NOTHING, the limit section 8 states for its own chunked arm
    // applies here too: the close under a mid-upload caller is an RST and the response it had
    // buffered is lost. What the server owns is the event: the upload was cut off, and a request
    // that sends NO body bytes still reads the full refusal with its close header. `raw` reports
    // only the status line and the body, so the header block is read on a plain socket here.
    const refusedHead = async (status: string, extra: string): Promise<string> =>
      await new Promise((resolve) => {
        let resp = "";
        const sock = net.connect(WEB_PORT, "127.0.0.1", () => {
          sock.write(strangerHead(`Content-Length: ${NO_BODY.length}\r\n${extra}`));
        });
        sock.on("data", (d) => { resp += d.toString("latin1"); });
        sock.on("error", () => {});
        sock.on("close", () => resolve(resp));
        setTimeout(() => { sock.destroy(); resolve(resp); }, 10_000);
      });

    const bodyless = await refusedHead("401", "");
    ok("9.0 an UNAUTHENTICATED announced 20 MB body to a no-body route is refused with 401 and that refusal closes the connection",
      bodyless.split("\r\n")[0].includes("401") && /connection:\s*close/i.test(bodyless),
      { head: bodyless.slice(0, 240) });

    const stranger = await raw(strangerHead(`Content-Length: ${NO_BODY.length}\r\n`), NO_BODY);
    ok("9.0b ...and a caller sending that announced body is cut off before it finishes, so the gate's refusal is not drained",
      stranger.sent < NO_BODY.length,
      { sent: stranger.sent, total: NO_BODY.length, status: stranger.status.slice(0, 60) });

    const chunked = await raw(strangerHead("Transfer-Encoding: chunked\r\n"), NO_BODY, asChunks);
    ok("9.1 ...and the same with transfer-encoding: chunked",
      chunked.sent < NO_BODY.length,
      { sent: chunked.sent, total: NO_BODY.length, status: chunked.status.slice(0, 60) });

    const crossBodyless = await refusedHead("403", "Origin: http://evil.example\r\n");
    const crossOrigin = await raw(strangerHead(`Content-Length: ${NO_BODY.length}\r\nOrigin: http://evil.example\r\n`), NO_BODY);
    ok("9.2 a CROSS-ORIGIN announced body is refused with 403 and closed the same way",
      crossBodyless.split("\r\n")[0].includes("403") && /connection:\s*close/i.test(crossBodyless)
      && crossOrigin.sent < NO_BODY.length,
      { head: crossBodyless.slice(0, 240), sent: crossOrigin.sent, total: NO_BODY.length });

    // THE NEGATIVE ARM, the reason the three cells above are scoped rather than a policy of
    // closing every refusal: a request that announces NO body keeps its socket, and the proof is
    // a second request answered on the SAME socket, the way 7.5/7.6 prove reuse for the cap.
    let twoResp = "";
    const keep = net.connect(WEB_PORT, "127.0.0.1");
    keep.on("data", (d) => { twoResp += d.toString("latin1"); });
    keep.on("error", () => {});
    await new Promise<void>((r) => { keep.on("connect", () => r()); setTimeout(r, 5000); });
    keep.write("POST /api/roster HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n");
    for (let i = 0; i < 100 && !twoResp.includes("\r\n\r\n"); i++) await wait(100);
    const first401 = twoResp;
    twoResp = "";
    const stillReusable = keep.writable && !keep.destroyed;
    if (stillReusable) keep.write("POST /api/roster HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n");
    for (let i = 0; i < 100 && !twoResp.includes("\r\n\r\n"); i++) await wait(100);
    ok("9.3 CONTROL: an unauthenticated request that announces NO body is refused with 401 and KEEPS its connection, so the remedy is scoped to announced uploads",
      first401.includes("401") && !/connection:\s*close/i.test(first401)
      && stillReusable && twoResp.includes("401"),
      { first: first401.slice(0, 160), second: twoResp.slice(0, 160) });
    keep.destroy();
  }
} finally {
  webChild?.kill("SIGKILL");
  release();
  broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}

console.log(`web body cap: ${failed === 0 ? `${cells} cells OK` : `${failed} of ${cells} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
