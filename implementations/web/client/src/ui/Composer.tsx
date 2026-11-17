import { ArrowUp02Icon, AtIcon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon } from "../icons/Icon.tsx";
import { Avatar, AvatarFallback } from "#client/ui/shadcn/avatar.tsx";
import { Badge } from "#client/ui/shadcn/badge.tsx";
import { Bubble, BubbleContent } from "#client/ui/shadcn/bubble.tsx";
import { Field, FieldDescription, FieldError } from "#client/ui/shadcn/field.tsx";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from "#client/ui/shadcn/input-group.tsx";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "#client/ui/shadcn/message.tsx";
import { MessageScrollerItem } from "#client/ui/shadcn/message-scroller.tsx";
import { useSidebar } from "#client/ui/shadcn/sidebar.tsx";
import { Spinner } from "#client/ui/shadcn/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";
import { composeKey, composerNote, messageRoute, POST_OFF_CREDS, sendCommand, type ComposeTarget } from "../lib/compose.js";
import { formatRoute } from "../lib/route.js";
import type { Controller } from "../state/controller.js";
import { useStore } from "../state/hooks.js";
import type { Store } from "../state/store.js";
import type { DashboardState, Draft } from "../state/types.js";
import { CopyCommand } from "./CopyCommand.tsx";
import { clock } from "../lib/time.js";

/** The controller's two composer calls, for the composers the views draw. Null before the dashboard
 *  has started, when the box is read only and nothing sends. */
export const Compose = createContext<Pick<Controller, "send" | "draft"> | null>(null);

/** The parts of an element the composer uses. Spelled out rather than taken from the DOM lib, because
 *  the suites typecheck the components that render on the server with no DOM lib. */
type TextBox = { focus(): void; value: string };

/** The composer the next Message button asked to focus, by `composeKey`. The first composer for that
 *  target to mount takes it and clears it, a composer that cannot post included, so a request the
 *  view could not honour does not move the focus on a later visit. */
let wanted: string | null = null;
const askers = new Set<() => void>();

/** Ask the composer for `target` to take the focus: the one on screen now, or the one the next view
 *  draws. Message buttons call it as their link opens the DM view. */
export function focusComposer(target: ComposeTarget): void {
  wanted = composeKey(target);
  for (const ask of askers) ask();
}

/** Our own copy with backticks around inline code. Never server text. */
const withCode = (text: string): ReactNode[] => text.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));

/** A target nothing has been typed for. */
const BLANK: Draft = { text: "", outgoing: [] };

/** The composer (mock section B, the four composer states, and section D's dock): the box and the
 *  note line under it, in every state. The box grows with the draft up to a cap, then scrolls.
 *
 *  - Nothing until `/api/meta` has said what the dashboard can post as.
 *  - Posting off: the reason with a lock, the command that posts from a terminal, a disabled send
 *    whose tooltip is the reason, and the note from `composerNote`. The command shrinks so the
 *    send stays inside the row.
 *  - Live: the box (`Message <where>`), Mention, the mode dot with `to`, "as operator", and send.
 *    Enter sends and Shift+Enter starts a new line.
 *  - Sending: send is disabled and spins until the server answers.
 *  - Refused: the draft is back in the box, the box is marked invalid, Try again replaces the row,
 *    and the note is the refusal, as plain text: the server's part of it is not ours to format.
 *
 *  On a phone (`useSidebar().isMobile`) the row fits the screen as mock D draws it: Mention is its
 *  icon alone, named for assistive tech, and "as operator" is left out. The mode line shrinks before
 *  the send button moves.
 *
 *  `where` is `#review` or the agent's name; `to` is the mode line, `to #review · 5 members`. */
export function Composer({ store, target, where, to }: { store: Store<DashboardState>; target: ComposeTarget; where: string; to: string }) {
  const key = composeKey(target);
  const post = useStore(store, (s) => s.post);
  const draft = useStore(store, (s) => s.drafts[key]) ?? BLANK;
  const ctl = useContext(Compose);
  const phone = useSidebar().isMobile;
  const box = useRef<HTMLTextAreaElement>(null);
  const field = () => box.current as unknown as TextBox | null;
  useLayoutEffect(() => {
    const take = () => {
      if (wanted !== key) return;
      wanted = null;
      field()?.focus();
    };
    take();
    askers.add(take);
    return () => void askers.delete(take);
  }, [key, post]);
  if (post === null) return null;

  if (post.mode === "off") {
    return (
      <Field>
        <InputGroup aria-disabled="true">
          <InputGroupAddon align="block-start">
            <Icon icon={SquareLock02Icon} />
            <InputGroupText>{post.reason === POST_OFF_CREDS ? withCode("This dashboard was started with `--creds`, which can only read.") : post.reason}</InputGroupText>
          </InputGroupAddon>
          <InputGroupAddon align="block-end" className="min-w-0">
            <CopyCommand command={sendCommand(target)} />
            <Tooltip>
              {/* A disabled button fires no pointer events, so the Tooltip hangs on a span around it,
                  which takes the focus instead. The reason is also the box's first line. */}
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0" tabIndex={0}>
                  <InputGroupButton variant="default" size="icon-xs" disabled aria-label="Send">
                    <Icon icon={ArrowUp02Icon} />
                  </InputGroupButton>
                </span>
              </TooltipTrigger>
              <TooltipContent>{post.reason}</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription className="truncate">{withCode(composerNote(post))}</FieldDescription>
      </Field>
    );
  }

  const sending = draft.outgoing.some((o) => o.id === undefined);
  const refused = draft.refused;
  const ready = ctl !== null && !sending && draft.text.trim() !== "";
  const submit = () => {
    // The refusal is in the store; the rethrow is for callers that wait on the post.
    if (ready) ctl.send(target, draft.text).catch(() => undefined);
  };
  const mention = () => {
    ctl?.draft(target, `${draft.text}@`);
    field()?.focus();
  };
  // A disabled control fires no pointer events, so where a Tooltip names it, it hangs on a span
  // around the control, which takes the focus while the control cannot.
  const pick = (
    <InputGroupButton size={phone ? "icon-xs" : "xs"} disabled={ctl === null} onClick={mention} aria-label={phone ? "Mention" : undefined}>
      <Icon icon={AtIcon} data-icon={phone ? undefined : "inline-start"} />
      {!phone && "Mention"}
    </InputGroupButton>
  );
  return (
    <Field data-invalid={refused !== undefined}>
      <InputGroup>
        <InputGroupTextarea
          ref={box}
          className="max-h-48"
          placeholder={`Message ${where}`}
          aria-label={`Message ${where}`}
          aria-invalid={refused !== undefined}
          value={draft.text}
          readOnly={ctl === null}
          onChange={(e) => ctl?.draft(target, (e.currentTarget as unknown as TextBox).value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || (e.nativeEvent as { isComposing?: boolean }).isComposing) return;
            e.preventDefault();
            submit();
          }}
        />
        <InputGroupAddon align="block-end">
          {refused === undefined ? (
            <>
              {phone ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex" tabIndex={ctl === null ? 0 : undefined}>{pick}</span>
                  </TooltipTrigger>
                  <TooltipContent>Mention</TooltipContent>
                </Tooltip>
              ) : pick}
              <InputGroupText className="ml-auto min-w-0">
                <i className="ui-mode-dot" style={{ background: target.kind === "msg" ? "var(--multi)" : "var(--uni)" }} />
                <span className="truncate">{to}</span>
              </InputGroupText>
              {!phone && <InputGroupText>as operator</InputGroupText>}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex" tabIndex={ready ? undefined : 0}>
                    <InputGroupButton variant="default" size="icon-xs" aria-label={sending ? "Sending" : "Send"} disabled={!ready} onClick={submit}>
                      {sending ? <Spinner /> : <Icon icon={ArrowUp02Icon} />}
                    </InputGroupButton>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{sending ? "Sending" : "Send"}</TooltipContent>
              </Tooltip>
            </>
          ) : (
            <InputGroupButton variant="outline" size="sm" className="ml-auto" disabled={!ready} onClick={submit}>Try again</InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
      {refused === undefined ? (
        <FieldDescription className="truncate">{withCode(composerNote(post))}</FieldDescription>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <FieldError className="truncate">{refused}</FieldError>
          </TooltipTrigger>
          <TooltipContent>{refused}</TooltipContent>
        </Tooltip>
      )}
    </Field>
  );
}

/** The operator's posts to `target` that the view does not show yet (mock section B, sending then
 *  sent), each in its own MessageScrollerItem as the operator's Message at the end side: in the muted
 *  bubble with "sending" after the time while the server has not answered, then in the operator's
 *  default bubble until the message itself arrives. `shown` is the ids the view already draws. The
 *  text is drawn as typed, not as Markdown. */
export function OutgoingRows({ store, target, shown }: { store: Store<DashboardState>; target: ComposeTarget; shown: ReadonlySet<string> }) {
  const draft = useStore(store, (s) => s.drafts[composeKey(target)]) ?? BLANK;
  return (
    <>
      {draft.outgoing.filter((o) => o.id === undefined || !shown.has(o.id)).map((o) => {
        const at = new Date(o.ts);
        const sending = o.id === undefined;
        return (
          <MessageScrollerItem key={o.seq}>
            <Message align="end">
              <MessageAvatar>
                <Avatar>
                  <AvatarFallback>OP</AvatarFallback>
                </Avatar>
              </MessageAvatar>
              <MessageContent>
                <MessageHeader className="gap-2">
                  <span>operator</span>
                  <Badge variant="secondary">operator</Badge>
                  <time dateTime={at.toISOString()}>{clock(at)}</time>
                  {sending && <span>sending</span>}
                </MessageHeader>
                <Bubble variant={sending ? "muted" : "default"}>
                  <BubbleContent className="whitespace-pre-wrap">{o.text}</BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
          </MessageScrollerItem>
        );
      })}
    </>
  );
}

/** In the dock of a conversation between two agents, which the operator is not in: the composer's
 *  box with one line saying so, and Message, which opens the operator's own conversation with `peer`
 *  with its composer focused. */
export function BetweenAgents({ peer, name, selfId }: { peer: string; name: string; selfId: string | null }) {
  return (
    <InputGroup>
      <InputGroupAddon align="block-start">
        <InputGroupText>This conversation is between two agents.</InputGroupText>
      </InputGroupAddon>
      <InputGroupAddon align="block-end">
        <InputGroupButton asChild variant="outline" size="sm" className="ml-auto">
          <a href={formatRoute(messageRoute(peer, selfId))} onClick={() => focusComposer({ kind: "dm", to: peer })}>{`Message ${name}`}</a>
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
