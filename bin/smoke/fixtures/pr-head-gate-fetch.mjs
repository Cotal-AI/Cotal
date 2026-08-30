const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const workflow = "name: Hidden\non: [push, pull_request] # ordinary YAML comment\n";
const run = {
  id: 1,
  name: "Hidden",
  event: "pull_request",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  created_at: "2026-08-30T00:00:00Z",
  pull_requests: [{ number: 1098 }],
};

const json = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const accept = new Headers(init.headers).get("accept") ?? "";
  if (url.pathname === "/repos/Cotal-AI/Cotal/pulls/1098") return json({ head: { sha } });
  if (url.pathname === "/repos/Cotal-AI/Cotal/pulls/1098/files") return json([]);
  if (url.pathname === "/repos/Cotal-AI/Cotal/contents/.github/workflows") {
    return json([{ type: "file", name: "hidden.yml", path: ".github/workflows/hidden.yml" }]);
  }
  if (url.pathname === "/repos/Cotal-AI/Cotal/contents/.github/workflows/hidden.yml" && accept.includes("raw")) {
    return new Response(workflow, { status: 200 });
  }
  if (url.pathname === "/repos/Cotal-AI/Cotal/actions/runs") {
    return json({ workflow_runs: process.env.PR_HEAD_GATE_FIXTURE === "missing" ? [] : [run] });
  }
  return new Response(`unexpected fixture request: ${url}`, { status: 500 });
};
