/**
 * Sliding-window rate limiting for agentgw.
 *
 * Redis-backed when REDIS_URL is set, with an in-memory fallback so local dev
 * and single-instance deploys still work without Redis.
 */

// Bun.redis typings drift across versions; keep it loose.
let redis: any = null;
let redisInitialized = false;

async function getRedis(): Promise<any> {
  if (redisInitialized) return redis;
  redisInitialized = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    // @ts-ignore Bun.redis may be absent in some type defs.
    redis = new Bun.Redis(url);
    return redis;
  } catch (err) {
    console.error("[ratelimit] redis connect failed, using memory:", err instanceof Error ? err.message : err);
    redis = null;
    return null;
  }
}

// In-memory fallback. Per-process only; evicted every 60s to bound growth.
const memory = new Map<string, number[]>();
const evictTimer: any = setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of memory) {
    const recent = ts.filter((t) => t > now - 60_000);
    if (recent.length === 0) memory.delete(k);
    else memory.set(k, recent);
  }
}, 60_000);
evictTimer.unref?.();

async function allow(key: string, max: number, windowMs: number): Promise<boolean> {
  const r = await getRedis();
  if (!r) return allowMemory(key, max, windowMs);
  try {
    const now = Date.now();
    const rk = `rl:${key}`;
    await r.send("ZREMRANGEBYSCORE", [rk, "0", String(now - windowMs)]);
    const count = Number(await r.send("ZCARD", [rk]));
    if (count >= max) return false;
    await r.send("ZADD", [rk, String(now), `${now}:${crypto.randomUUID()}`]);
    await r.send("PEXPIRE", [rk, String(windowMs)]);
    return true;
  } catch {
    // Redis hiccup: don't take the gateway down over rate limiting.
    return true;
  }
}

function allowMemory(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (memory.get(key) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  memory.set(key, recent);
  return true;
}

export function allowUser(userId: string): Promise<boolean> {
  return allow(`user:${userId}`, 100, 60_000);
}

export function allowIp(ip: string): Promise<boolean> {
  return allow(`ip:${ip}`, 30, 60_000);
}
