// Times launch to visible text under tmux, the harness the prototype's 3.4 s figure came from: a
// 120x30 pane on a private server, polled every 5 ms, median of the runs. Each --mark is
// name=text and records when that text first shows.
// Usage: node scripts/measure-startup.mjs [--runs 9] [--cwd <dir>] [--cmd "node bin/cotal-tui.mjs"] --mark frame="not connected" --mark catalog=team-alpha
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "9" },
    cwd: { type: "string", default: fileURLToPath(new URL("..", import.meta.url)) },
    cmd: { type: "string", default: "node bin/cotal-tui.mjs" },
    mark: { type: "string", multiple: true, default: ['frame=not connected', "catalog=team-alpha"] },
  },
})
const marks = values.mark.map((m) => {
  const at = m.indexOf("=")
  if (at < 1) throw new Error(`--mark takes name=text, got ${m}`)
  return { name: m.slice(0, at), text: m.slice(at + 1) }
})

const work = fs.mkdtempSync(path.join(os.tmpdir(), "cotal-tui-startup-"))
const home = path.join(work, "cotal")
process.env.COTAL_HOME = home
const w = await import("@cotal-ai/workspace")
const ts = new Date(0).toISOString()
w.recordMesh({ space: "team-alpha", server: "nats://127.0.0.1:4222", root: "/srv/alpha", mode: "auth", origin: "up", ts })
w.recordMesh({ space: "research", server: "nats://10.0.0.7:4222", root: "/home/op/research", mode: "user", origin: "manual", ts })
w.recordMesh({ space: "scratch-open", server: "nats://127.0.0.1:14222", root: "/tmp/scratch", mode: "open", ts })
w.setCurrent("team-alpha")
fs.writeFileSync(path.join(w.meshesDir(), "broken.json"), "{ not json")

const socket = `cotal-tui-startup-${process.pid}`
const tmux = (...args) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args]).toString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = Object.fromEntries(marks.map((m) => [m.name, []]))
try {
  for (let i = 0; i < Number(values.runs); i++) {
    try {
      tmux("kill-session", "-t", "t")
    } catch {}
    const started = performance.now()
    tmux("new-session", "-d", "-s", "t", "-x", "120", "-y", "30", `cd ${values.cwd} && env COTAL_HOME=${home} ${values.cmd} 2>/dev/null; sleep 3600`)
    const pending = new Set(marks)
    while (pending.size) {
      if (performance.now() - started > 20000) throw new Error(`run ${i}: timed out waiting for ${[...pending].map((m) => m.text).join(", ")}`)
      const frame = tmux("capture-pane", "-p", "-t", "t")
      const now = performance.now()
      for (const m of [...pending]) if (frame.includes(m.text)) results[m.name].push(now - started), pending.delete(m)
      await sleep(5)
    }
  }
} finally {
  try {
    tmux("kill-server")
  } catch {}
  fs.rmSync(work, { recursive: true, force: true })
}

console.log(`node ${process.version}, ${values.runs} runs, cmd: ${values.cmd} (cwd ${values.cwd})`)
for (const m of marks) {
  const ms = results[m.name]
  const sorted = [...ms].sort((a, b) => a - b)
  console.log(`${m.name} ("${m.text}"): median ${sorted[sorted.length >> 1].toFixed(0)} ms, min ${sorted[0].toFixed(0)}, max ${sorted.at(-1).toFixed(0)}; runs ${ms.map((n) => n.toFixed(0)).join(", ")}`)
}
