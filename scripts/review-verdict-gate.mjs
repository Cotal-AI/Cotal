#!/usr/bin/env node
// Refuse a pull request whose recorded approval does not name its current head.
//
// This repository records review verdicts in the PR body, and nothing compared the sha a verdict
// named with the sha that merged: #1394 merged five commits past the head its reviews had seen
// (#1418). This passes only when a paragraph of the PR body reads `Approved-at: <sha>` naming the
// event's head in full. A push moves the head and leaves the paragraph naming the old one, so the
// PR stays refused until someone approves the new head and edits it. The edit is itself a
// pull_request event and re-runs this with the new body; re-running the job replays the old event.
//
// Usage:
//   node scripts/review-verdict-gate.mjs --event <github-event.json>
//
// Exit 0 approved at the head, 1 refused, 2 the check could not run (bad arguments or event).

import { readFileSync } from 'node:fs';
import { lexer } from 'marked';
import { isMainEntry } from './main-entry.mjs';

const SHA = /^[0-9a-f]{40}$/;

function main(argv) {
  const [flag, eventPath, ...rest] = argv.slice(2);
  if (flag !== '--event' || !eventPath || rest.length > 0) {
    throw new Error('usage: review-verdict-gate.mjs --event <event.json>');
  }
  const pr = JSON.parse(readFileSync(eventPath, 'utf8')).pull_request;
  const head = pr?.head?.sha;
  if (typeof head !== 'string' || !SHA.test(head)) throw new Error(`event carries no full pull request head sha: ${head}`);
  // A line in a code block is quoted and one in an HTML comment is hidden, so neither records an
  // approval. Only a whole top-level paragraph counts, because a comment opened mid-paragraph hides
  // the lines after it.
  const named = lexer(pr.body ?? '')
    .filter((token) => token.type === 'paragraph')
    .map((paragraph) => /^Approved-at:[ \t]*(.*?)[ \t]*$/.exec(paragraph.text)?.[1])
    .filter((sha) => sha !== undefined);
  if (named.includes(head)) {
    console.log(`review verdict: approved at the head ${head}.`);
    return 0;
  }
  console.log(`review verdict: no Approved-at paragraph in the PR body names the head ${head}.`);
  for (const sha of named) {
    console.log(`  Approved-at: ${sha} ${SHA.test(sha) ? 'names another commit' : 'is not a full 40-character sha'}`);
  }
  console.log('Review this exact head, then add `Approved-at: <full head sha>` to the PR body as its own paragraph.');
  return 1;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error(`review verdict: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
