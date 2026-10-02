#!/usr/bin/env bash
# Resolve the commit the mutation-reproof selector must diff against, and print it on stdout.
#
# WHY THIS EXISTS, measured on PR #1520 job 103730155053 and PR #1524 job 103752892987:
#
# On `pull_request`, actions/checkout checks out `refs/pull/N/merge`, so HEAD is a MERGE COMMIT whose
# FIRST parent is the base branch tip and whose second is the PR head:
#
#   HEAD is now at 8660c6708 Merge aca73b871 into 7df3498cb
#
# HEAD therefore already CONTAINS the base branch tip. Any `<base>...HEAD` walk from a commit older
# than that tip reports main's own commits since the fork as though the PR had made them, and the
# selector's three-dot diff cannot help: three-dot resolves to `merge-base(base, HEAD)..HEAD`, and
# once HEAD contains the base tip the merge base IS the fork point, so main's intervening commits sit
# on the included side. #1520 read 30 changed paths where its own diff had 4, selected two fixtures
# belonging to commits it merely lacked, and ran 146 minutes to produce no fact about its own files.
#
# Normalising the event's BASE with `git merge-base "$BASE" HEAD` does NOT fix this. That was the
# prescribed fix in #1582 and it is a measured no-op: #1520's job was already handed
# a707174bbfd94deea7c45b8f475df2543ddbe41a, which is precisely what that expression returns.
#
# The PR's own change is exactly `HEAD^1..HEAD`, so when HEAD is a merge the FIRST PARENT is the base.
# Verified against GitHub's own file list: #1520 4 files, #1524 22 files, both matched exactly.
#
# Every other arrival shape keeps the old meaning: a push carries `github.event.before`, the tip the
# branch was at before the push, and that is normalised to the divergence point, which is a no-op when
# it is already an ancestor. A first push or a missing base falls back to the first parent.
#
# THE FIRST-PARENT RULE IS GATED ON THE EVENT, and it must be: a merge head is not exclusive to pull
# requests. `allow_merge_commit` is on, main carries 28 merge commits since 2026-09-06, and six real
# push-triggered runs of this workflow had a two-parent head (34001974040, 33991120039, 33985829621,
# 33981431625, 33979071588, 33972300304). A push landing on a merge is therefore a shape that really
# occurs. On a push the whole pushed range is the change, merge head or not: taking HEAD^1 there would
# discard `event.before` and diff only the merge itself, dropping every commit the push also landed.
# Direct-to-main commits are exactly the ones no pull request run ever proved, so that loss is coverage
# nothing else replaces. How much a given push would lose depends on `event.before`, which is not
# recoverable from history after the fact, so no such count is quoted here. Consecutive run heads do
# NOT bound one push, because a commit marked [skip ci] produces no run at all. The push cell in the
# smoke suite pins the behaviour by construction instead.
#
# An unresolvable base FAILS LOUD. A shallow checkout returns an empty merge base, which is
# indistinguishable from "no common ancestor"; diffing against nothing selects zero fixtures and the
# gate goes green having proven nothing. All three checkouts in the workflow use `fetch-depth: 0`
# for this reason, and this refusal is what catches a future change that drops it.
set -euo pipefail

event="${1-}"
base="${2-}"
head="${3-HEAD}"

die() {
  echo "mutation reproof: UNMEASURED: $1" >&2
  exit 2
}

# An unknown event is refused rather than guessed at. Guessing here picks the wrong base silently,
# which is the entire defect this script exists to remove.
#
# `pull_request_target` is deliberately NOT listed, and that is a correction: an earlier revision of
# this script named it beside `pull_request` on the assumption that a fork pull request checks out a
# merge ref the same way. It does not. GitHub documents `pull_request_target` as running with
# GITHUB_SHA at the last commit on the DEFAULT BRANCH, "rather than in the context of the merge
# commit, as the pull_request event does", and it carries a `pull_request` payload, which has no
# `before` field, so the workflow's BASE expression yields an empty string on it.
#
# Measured consequence of listing it, on a repository whose default branch tip is a merge (this one:
# `allow_merge_commit` is on and main carries 28 merge commits since 2026-09-06). The checkout is
# main's tip, so `HEAD^2` exists and belongs to somebody else's merged pull request. The first-parent
# rule then resolves to main-before-that-unrelated-merge and selects THAT pull request's fixtures,
# exiting 0 and saying nothing. Dropping only the arm does not help either: the empty-base fallback
# takes `HEAD~1`, which on a merge is the same commit, so it reaches the identical wrong answer.
# Both spellings are silently wrong; there is no base for "this pull request" to be found in that
# checkout at all, because the pull request's head is not in it.
#
# So the event is refused. If this workflow ever adds a `pull_request_target` trigger, the selector
# stops loudly and whoever adds it must decide what base it means, rather than inheriting an answer
# derived from a premise that was never true. That refusal is the behaviour a cell pins below.
case "$event" in
  pull_request|push|schedule|workflow_dispatch) ;;
  "") die "no event name given; pass github.event_name as the first argument" ;;
  *) die "unknown event '$event'; this selector must not guess which base an unrecognised event implies" ;;
esac

second=""
if [ "$event" = pull_request ]; then
  second="$(git rev-parse --verify --quiet "${head}^2" 2>/dev/null || true)"
fi
if [ -n "$second" ]; then
  # A pull request checked out at its merge ref: the first parent is the base branch tip.
  first="$(git rev-parse --verify --quiet "${head}^1" 2>/dev/null || true)"
  [ -n "$first" ] || die "HEAD is a merge commit whose first parent does not resolve"
  base="$first"
else
  if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ]; then
    base="$(git rev-parse --verify --quiet "${head}~1" 2>/dev/null || true)"
    [ -n "$base" ] || die "no base commit on this event and no first parent to fall back to"
    echo "no base commit on this event; using first parent $base" >&2
  fi
  resolved="$(git merge-base "$base" "$head" 2>/dev/null || true)"
  [ -n "$resolved" ] \
    || die "cannot resolve a merge base between $base and $head; a shallow checkout answers this exactly as a repository with no common ancestor does, and diffing against nothing would select zero fixtures and report a green gate that proved nothing (the workflow checks out with fetch-depth: 0)"
  base="$resolved"
fi

full="$(git rev-parse --verify --quiet "$base" 2>/dev/null || true)"
[ -n "$full" ] || die "resolved base $base does not name a commit in this checkout"
printf '%s\n' "$full"
