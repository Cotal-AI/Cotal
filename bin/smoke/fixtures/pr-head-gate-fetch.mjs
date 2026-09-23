const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hidden = "name: Hidden\non: [push, pull_request] # ordinary YAML comment\n";
const mergeKey = `name: Merge
jobs:
  j:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - anchor: &events { pull_request: null }
    steps: [{run: echo hi}]
on:
  <<: *events
  push:
`;
const hiddenRun = {
  id: 1,
  name: "Hidden",
  event: "pull_request",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  created_at: "2026-08-30T00:00:00Z",
  pull_requests: [{ number: 1098 }],
};
const mergeKeyMode = process.env.PR_HEAD_GATE_FIXTURE === "merge-key";

const json = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const accept = new Headers(init.headers).get("accept") ?? "";
  if (url.pathname === "/repos/Cotal-AI/Cotal/pulls/1098") return json({ head: { sha } });
  if (url.pathname === "/repos/Cotal-AI/Cotal/pulls/1098/files") {
    return json(mergeKeyMode ? [{ filename: "package.json" }] : []);
  }
  if (url.pathname === "/repos/Cotal-AI/Cotal/contents/.github/workflows") {
    return json(mergeKeyMode
      ? [{ type: "file", name: "merge.yml", path: ".github/workflows/merge.yml" }]
      : [{ type: "file", name: "hidden.yml", path: ".github/workflows/hidden.yml" }]);
  }
  if (url.pathname === "/repos/Cotal-AI/Cotal/contents/.github/workflows/hidden.yml" && accept.includes("raw")) {
    return new Response(hidden, { status: 200 });
  }
  if (url.pathname === "/repos/Cotal-AI/Cotal/contents/.github/workflows/merge.yml" && accept.includes("raw")) {
    return new Response(mergeKey, { status: 200 });
  }
  if (url.pathname === "/repos/Cotal-AI/Cotal/actions/runs") {
    if (mergeKeyMode) return json({ workflow_runs: [] });
    return json({ workflow_runs: process.env.PR_HEAD_GATE_FIXTURE === "missing" ? [] : [hiddenRun] });
  }
  return new Response(`unexpected fixture request: ${url}`, { status: 500 });
};
