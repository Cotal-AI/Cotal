/** Count messages actually sent by the test broker, not calls to a client helper. */
export async function connzOutMessages(port: number, cid: number): Promise<number> {
  const reply = await fetch(`http://127.0.0.1:${port}/connz?cid=${cid}`, { signal: AbortSignal.timeout(3000) });
  const { connections } = await reply.json() as { connections?: { cid: number; out_msgs: number }[] };
  const count = connections?.find(row => row.cid === cid)?.out_msgs;
  if (!reply.ok || count === undefined) throw new Error(`monitoring did not report connection ${cid}`);
  return count;
}
