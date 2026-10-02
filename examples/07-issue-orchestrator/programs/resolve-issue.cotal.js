// Resolve one GitHub issue as one lane: reproduce, fix and open a PR, two independent reviews,
// merge. The operator names the issue by answering the `issue` checkpoint with {"issue": <number>}.
// The lane block below is shared verbatim with resolve-issues.cotal.js; `pnpm check` refuses a
// drift between the two copies.

// ---- lane: begin (shared verbatim with resolve-issues.cotal.js) ----
const REVIEW_ROUNDS = 2

// Seat-supplied text as a notice detail: printable ASCII on one line, at most 128 characters, none
// of the characters a run-context row refuses.
function oneLine(text) {
  let out = ""
  for (const ch of `${text}`) {
    if (ch < " " || ch > "~" || ch === "\"" || ch === "<" || ch === ">") {
      out += " "
    } else {
      out += ch
    }
  }
  return out.trim().slice(0, 128)
}

function laneRecord(issue, outcome, fields) {
  return merge({ issue, outcome, sha: null, pr: null, mergeSha: null, rounds: 0, blockers: [] }, fields)
}

// One reviewer's verdict at the expected sha. Anything but APPROVE naming that sha is a block.
function judge(key, verdict, sha) {
  if (verdict.sha !== sha) {
    return { key, approved: false, blockers: [`${key}: verdict names ${verdict.sha}, expected ${sha}`] }
  }
  if (verdict.verdict !== "APPROVE") {
    const named = verdict.blockers.length === 0 ? ["blocked without a named blocker"] : verdict.blockers
    return { key, approved: false, blockers: map(named, (b) => `${key}: ${b}`) }
  }
  return { key, approved: true, blockers: [] }
}

// Step names must be literals, so each reviewer's steps are spelled out: the journal then names
// which reviewer graded, and a script answers each reviewer by name rather than by arrival order.
async function grade(issue, reviewer, key, pr, sha, pass) {
  await notify([reviewer], {
    decision: pass === 1 ? "review" : "regrade",
    outcome: "grade",
    detail: { issue, pr, sha: oneLine(sha), pass },
  })
  const schema = { verdict: "string", sha: "string", blockers: "array" }
  let verdict = null
  if (key === "a" && pass === 1) {
    await turn(reviewer, { name: "grade-a", deadline: "2h" })
    verdict = await ask(reviewer, { name: "verdict-a", schema, deadline: "30m", attempts: 2 })
  } else if (key === "b" && pass === 1) {
    await turn(reviewer, { name: "grade-b", deadline: "2h" })
    verdict = await ask(reviewer, { name: "verdict-b", schema, deadline: "30m", attempts: 2 })
  } else if (key === "a") {
    await turn(reviewer, { name: "regrade-a", deadline: "1h" })
    verdict = await ask(reviewer, { name: "reverdict-a", schema, deadline: "30m", attempts: 2 })
  } else {
    await turn(reviewer, { name: "regrade-b", deadline: "1h" })
    verdict = await ask(reviewer, { name: "reverdict-b", schema, deadline: "30m", attempts: 2 })
  }
  return judge(key, verdict, sha)
}

async function resolveLane(issue) {
  const lane = `issue-${issue}`
  try {
    const worker = await spawn("issue_worker", { name: "worker", worktree: lane, permits: { turns: 6, wallClock: "1d" } })
    await notify([worker], { decision: "assign", outcome: "reproduce", detail: { issue, worktree: lane } })
    await turn(worker, { name: "reproduce", deadline: "2h" })
    const repro = await ask(worker, { name: "reproduced", schema: { reproduced: "boolean", evidence: "string" }, deadline: "30m", attempts: 2 })
    if (!repro.reproduced) {
      await notify([worker], { decision: "reproduce", outcome: "not-reproduced", detail: { issue } })
      return laneRecord(issue, "not-reproduced", { blockers: [`not reproduced: ${oneLine(repro.evidence)}`] })
    }

    await turn(worker, { name: "fix", deadline: "4h" })
    const opened = await ask(worker, { name: "opened", schema: { sha: "string", pr: "number" }, deadline: "30m", attempts: 2 })
    let sha = opened.sha
    let pr = opened.pr

    const seats = await fanOut(["a", "b"], async (key) => {
      return await spawn(`reviewer_${key}`, { name: "reviewer", worktree: `review-${issue}-${key}`, permits: { turns: 4, wallClock: "1d" } })
    }, { name: "reviewers", key: (key) => key })
    const reviewers = { a: seats[0], b: seats[1] }

    let pass = 1
    let results = await fanOut(["a", "b"], (key) => grade(issue, reviewers[key], key, pr, sha, 1), { name: "review", key: (key) => key })
    let blockers = concat(results[0].blockers, results[1].blockers)
    while (blockers.length > 0 && pass < REVIEW_ROUNDS) {
      pass += 1
      await notify([worker], { decision: "review", outcome: "blocked", detail: { issue, pr, sha: oneLine(sha), first: oneLine(blockers[0]), count: blockers.length } })
      await turn(worker, { name: "address", deadline: "4h" })
      const revised = await ask(worker, { name: "revised", schema: { sha: "string", pr: "number" }, deadline: "30m", attempts: 2 })
      sha = revised.sha
      pr = revised.pr
      results = await fanOut(["a", "b"], (key) => grade(issue, reviewers[key], key, pr, sha, pass), { name: "regrade", key: (key) => key })
      blockers = concat(results[0].blockers, results[1].blockers)
    }
    if (blockers.length > 0) {
      await notify([worker], { decision: "review", outcome: "capped", detail: { issue, pr, sha: oneLine(sha), rounds: pass } })
      return laneRecord(issue, "blocked", { sha, pr, rounds: pass, blockers })
    }

    const merger = await spawn("merger", { name: "merger", worktree: `merge-${issue}`, permits: { turns: 2, wallClock: "4h" } })
    await notify([merger], { decision: "merge", outcome: "approved", detail: { issue, pr, sha: oneLine(sha) } })
    await turn(merger, { name: "merge", deadline: "1h" })
    const merged = await ask(merger, { name: "merged", schema: { merged: "boolean", mergeSha: "string" }, deadline: "30m", attempts: 2 })
    if (!merged.merged) {
      return laneRecord(issue, "merge-refused", { sha, pr, rounds: pass, blockers: ["the merger refused the merge"] })
    }
    return laneRecord(issue, "merged", { sha, pr, mergeSha: merged.mergeSha, rounds: pass })
  } catch (e) {
    // A lane that fails ends as its own record, so one failed lane never cancels its siblings.
    return laneRecord(issue, "failed", { blockers: [`${e.code ?? "error"} ${e.kind ?? ""}: ${oneLine(e.message ?? "")}`] })
  }
}
// ---- lane: end ----

const picked = await checkpoint("issue", "Which issue number should this lane resolve? Answer {\"issue\": <number>}.", { timeout: "1d" })
const issue = picked.value?.issue
assert(typeof issue === "number" && issue > 0, "answer the issue checkpoint with {\"issue\": <positive number>}")
log("lane", await resolveLane(issue))
