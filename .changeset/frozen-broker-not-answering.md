---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A broker that accepts the connection and never answers, as a stopped or overloaded one does, is no longer reported as not running, and `status` no longer hangs on it. `ps`, `who`, `send` and `history` refused such a broker with "no mesh running at <url>; ... recorded at <root> but not running". They now say it "accepted the connection but is not answering", keep the registry entry, and name checking that the broker is not stopped or overloaded. `cotal meshes add` and a raw `--server` connect use the same wording. `status` printed its report and then never exited, because its manager service probe dialed the broker without first reading its greeting and the client library left that socket open. `status` and `status --components` now read the greeting first, report the manager service as unchecked or refused, and exit.
