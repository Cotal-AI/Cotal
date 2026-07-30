import assert from "node:assert/strict";
import test from "node:test";
import { codexConnector } from "../src/extension.js";
import { codexChildEnv } from "../src/env.js";

test("launch preserves local Codex login roots without forwarding OPENAI_API_KEY", () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";
  try {
    const launch = codexConnector.buildLaunch({
      space: "mesh",
      name: "worker",
      id: "agent-id",
      lifecycleUid: "life-1",
      model: "gpt-5.4",
      variant: "high",
      launchOptions: { approval_policy: "on-request", sandbox_mode: "workspace-write" },
    });
    assert.equal(launch.command, process.execPath);
    assert.equal(launch.env?.OPENAI_API_KEY, undefined);
    assert.equal(launch.env?.HOME, process.env.HOME);
    assert.equal(launch.env?.COTAL_CODEX_MODEL, "gpt-5.4");
    assert.equal(launch.env?.COTAL_CODEX_EFFORT, "high");
    assert.equal(
      launch.env?.COTAL_CODEX_THREAD_CONFIG,
      '{"approval_policy":"on-request","sandbox_mode":"workspace-write"}',
    );
    assert.ok(launch.control?.path);
    assert.ok(launch.control?.token);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("Codex children inherit login roots but not mesh credentials", () => {
  const env = codexChildEnv({
    HOME: "/home/example",
    XDG_CONFIG_HOME: "/config",
    CODEX_HOME: "/codex",
    OPENAI_API_KEY: "provider-secret",
    COTAL_CREDS: "/mesh.creds",
    COTAL_CONTROL_TOKEN: "control-secret",
    PATH: "/bin",
  });

  assert.equal(env.HOME, "/home/example");
  assert.equal(env.XDG_CONFIG_HOME, "/config");
  assert.equal(env.CODEX_HOME, "/codex");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.COTAL_CREDS, undefined);
  assert.equal(env.COTAL_CONTROL_TOKEN, undefined);
  assert.equal(env.COTAL_CODEX_MCP_TOKEN, undefined);
});

test("unsupported resume, transcript, and shared-server modes fail before launch", () => {
  const base = { space: "mesh", name: "worker" };
  assert.throws(
    () => codexConnector.buildLaunch({ ...base, resume: "thread" }),
    /resume is not implemented/,
  );
  assert.throws(
    () => codexConnector.buildLaunch({ ...base, transcript: true }),
    /transcript mirroring is not implemented/,
  );
  assert.throws(
    () =>
      codexConnector.buildLaunch({
        ...base,
        mcpServers: { extra: { command: "example" } },
      }),
    /mcpServers sharing is not implemented/,
  );
});
