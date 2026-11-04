import type { StartupBlocker, StartupReply } from "@cotal-ai/core";

/** An authorized managed launch accepts its workspace through Claude's own dialog, which Claude
 * draws in one of two layouts. A numbered list with Yes first and selected is confirmed with Enter.
 * A list with No first and selected gets Down, then Enter only once Yes shows selected, rather than
 * a blind answer to the default No choice. Claude persists its own trust state; Cotal never edits
 * the operator's config file. */
export const CLAUDE_WORKSPACE_TRUST_REPLIES: readonly StartupReply[] = Object.freeze([
  Object.freeze({ prompt: "❯ 1. Yes, I trust this folder\n2. No, exit", key: "Enter" as const, optional: true }),
  Object.freeze({ prompt: "❯ No, exit\nYes, I trust this folder", key: "Down" as const }),
  Object.freeze({ prompt: "No, exit\n❯ Yes, I trust this folder", key: "Enter" as const }),
]);

/** Claude's input screen. Claude skips the development-channels warning when channels are off for
 * the session, for example under a Team or Enterprise org that has not set `channelsEnabled`, or on
 * a third-party provider. Its footer then shows `(shift+tab to cycle)` in every permission mode but
 * the default one, which shows `? for shortcuts`. No startup dialog draws either text. */
export const CLAUDE_READY_TEXTS: readonly string[] = Object.freeze(["(shift+tab to cycle)", "? for shortcuts"]);

/** Screens Claude shows before its input screen that only its user may answer: the first-run text
 * style picker, the login method choice, and the Bypass Permissions warning that a managed seat's
 * default mode raises until its user accepts it once. Cotal never answers them; a seat that stops on
 * one fails at the startup bound with the step that clears it. */
export const CLAUDE_STARTUP_BLOCKERS: readonly StartupBlocker[] = Object.freeze([
  Object.freeze({
    prompt: "Choose the text style that looks best with your terminal",
    reason: "Claude Code is showing its first-run setup, which Cotal does not answer. Run `claude` once in a terminal as this user, finish setup and log in, then launch again.",
  }),
  Object.freeze({
    prompt: "Select login method:",
    reason: "Claude Code is not logged in for this user and asks for a login method, which Cotal does not answer. Run `claude` once in a terminal and log in, or pass a credential the connector forwards, such as CLAUDE_CODE_OAUTH_TOKEN, then launch again.",
  }),
  Object.freeze({
    prompt: "WARNING: Claude Code running in Bypass Permissions mode",
    reason: "Claude Code asks this user to accept Bypass Permissions mode, which a managed seat uses by default, and Cotal never accepts it for you. Accept it once yourself with `claude --permission-mode bypassPermissions` in a terminal, or launch with permission-mode=default (`--opt permission-mode=default`, or `launchOptions` in a manifest).",
  }),
]);
