import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export async function until<T>(name: string, read: () => Promise<T>, accept: (value: T) => boolean, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  do {
    try { const value = await read(); if (accept(value)) return value; last = value; }
    catch (error) { last = String(error); }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`${name} timed out: ${JSON.stringify(last)}`);
}

/** Small W3C client. Tests interact through native WebDriver, never invoke stubs. */
export class WindowDriver {
  session?: string;
  constructor(readonly url = "http://127.0.0.1:4444") {}
  async call(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.url}${path}`, { method, signal: AbortSignal.timeout(120_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const reply = await response.json() as { value: any };
    if (!response.ok || reply.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(reply.value)}`);
    return reply.value;
  }
  async open(application: string, args: string[] = []): Promise<void> {
    const result = await this.call("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, args } } } });
    this.session = result.sessionId;
    assert.ok(this.session, "native WebDriver returned a session");
    await this.call("POST", this.path("timeouts"), { implicit: 0, script: 10_000, pageLoad: 60_000 });
  }
  path(path: string): string { assert.ok(this.session); return `/session/${this.session}/${path}`; }
  async element(id: string): Promise<string> {
    assert.match(id, /^[a-z][a-z0-9-]*$/);
    const result = await this.call("POST", this.path("element"), { using: "css selector", value: `#${id}` });
    return result["element-6066-11e4-a52e-4f735466cecf"];
  }
  async text(id: string): Promise<string> { return this.call("GET", this.path(`element/${await this.element(id)}/text`)); }
  async textContent(id: string): Promise<string> {
    assert.match(id, /^[a-z][a-z0-9-]*$/);
    return this.call("POST", this.path("execute/sync"), {
      script: "const matches=document.querySelectorAll('#'+arguments[0]); if(matches.length!==1) throw new Error('stable ID must name one element'); const e=matches[0]; if(!e.checkVisibility()) throw new Error('stable ID must be visible'); return e.textContent;",
      args: [id],
    });
  }
  async displayed(id: string): Promise<boolean> { return this.call("GET", this.path(`element/${await this.element(id)}/displayed`)); }
  async enabled(id: string): Promise<boolean> { return this.call("GET", this.path(`element/${await this.element(id)}/enabled`)); }
  async click(id: string): Promise<void> {
    await until(`${id} actionable`, async () => await this.displayed(id) && await this.enabled(id), Boolean);
    await this.call("POST", this.path(`element/${await this.element(id)}/click`), {});
  }
  async clickTestId(id: string): Promise<void> {
    assert.match(id, /^[a-z][a-z0-9-]*$/);
    const element = await until(`${id} actionable`, async () => {
      const values = await this.call("POST", this.path("elements"), { using: "css selector", value: `[data-testid="${id}"]` });
      assert.equal(values.length, 1, "test ID names one owned control");
      const key = values[0]["element-6066-11e4-a52e-4f735466cecf"];
      return await this.call("GET", this.path(`element/${key}/displayed`)) && await this.call("GET", this.path(`element/${key}/enabled`)) ? key as string : undefined;
    }, Boolean);
    await this.call("POST", this.path(`element/${element}/click`), {});
  }
  async testIdAttributes(id: string, attribute: string): Promise<string[]> {
    assert.match(id, /^[a-z][a-z0-9-]*$/); assert.match(attribute, /^data-[a-z-]+$/);
    const values = await this.call("POST", this.path("elements"), { using: "css selector", value: `[data-testid="${id}"]` });
    return Promise.all(values.map((value: Record<string, string>) => this.call("GET", this.path(`element/${value["element-6066-11e4-a52e-4f735466cecf"]}/attribute/${attribute}`))));
  }
  async fill(id: string, text: string): Promise<void> {
    const element = await this.element(id);
    await this.call("POST", this.path(`element/${element}/clear`), {});
    await this.call("POST", this.path(`element/${element}/value`), { text });
  }
  async enter(id: string): Promise<void> {
    await this.call("POST", this.path(`element/${await this.element(id)}/value`), { text: "\uE007" });
  }
  async select(id: string, value: string): Promise<void> {
    // The only script sets the value of the stable-ID native select and dispatches its user event.
    await this.call("POST", this.path("execute/sync"), { script: "const e=document.getElementById(arguments[0]); e.value=arguments[1]; e.dispatchEvent(new Event('change',{bubbles:true})); return e.value;", args: [id, value] });
  }
  async screenshot(path: string): Promise<void> {
    writeFileSync(path, Buffer.from(await this.call("GET", this.path("screenshot")), "base64"));
  }
  async close(): Promise<void> {
    if (this.session) {
      try { await this.call("DELETE", `/session/${this.session}`); }
      finally { this.session = undefined; }
    }
  }
}
