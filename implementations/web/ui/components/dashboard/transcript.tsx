import { useRef, useState } from "react";
import { ArrowDownToLine, ChevronDown, Pause, Play, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { OrderingNotice } from "./ordering-notice";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller } from "@/components/ui/message-scroller";
import { Blank, Hint, MessageBody, Status } from "./primitives";
import type { Row, Snapshot } from "@/lib/dashboard-types";

export function Transcript({ state }: { state: Snapshot }) {
  const store = window.COTAL_DASHBOARD;
  const all = state.selected === "*";
  const dm = state.dmSel !== null;
  const channel = state.channels.find(ch => ch.name === state.selected);
  const rows = dm ? state.conversation?.msgs ?? [] : all ? state.rows : state.channelRows;
  const view = `${state.selected}:${state.dmSel?.peer}:${state.dmSel?.with}`;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const titleElement = useRef<HTMLHeadingElement>(null);
  async function removeChannel() {
    if (!state.selected) return;
    setDeleting(true);
    setDeleteError(null);
    try { await store.deleteChannel(state.selected); setDeleteOpen(false); toast.success("Channel deleted"); }
    catch (error) { setDeleteError(error instanceof Error ? error.message : String(error)); }
    finally { setDeleting(false); }
  }
  const title = all ? "All activity" : dm ? `${state.conversation?.peerName ?? "Direct messages"} ↔ ${state.conversation?.withName ?? "Unknown peer"}` : state.selected ?? "Channel";
  return <AlertDialog open={deleteOpen} onOpenChange={open => { if (!deleting) { if (open) setDeleteError(null); setDeleteOpen(open); } }}><MessageScrollerProvider key={view} autoScroll={!all || !state.paused} defaultScrollPosition="end"><section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="Messages">
    <div className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-5">
      <div className="flex min-w-0 flex-col gap-1"><div className="flex items-center gap-2"><h1 ref={titleElement} tabIndex={-1} className="truncate text-lg font-semibold outline-none">{title}</h1>{dm && <Badge variant="secondary">Direct</Badge>}</div>
        <p className="text-xs text-muted-foreground">{all ? `${rows.length} recent messages · ${state.connected ? "live updates" : "disconnected"}` : dm ? `Unicast · private conversation · ${rows.length} messages` : `${channel?.description ? channel.description + " · " : ""}${channel?.messages ?? rows.length} messages · ${state.members.length} participants`}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {all && <><ToggleGroup type="multiple" variant="outline" size="sm" value={state.modes} onValueChange={store.setModes} aria-label="Delivery modes">{["chat","unicast","anycast"].map(mode => <ToggleGroupItem key={mode} value={mode} aria-label={`Show ${mode}`}>{mode}</ToggleGroupItem>)}</ToggleGroup>
          <PauseControl paused={state.paused} /></>}
        {rows.some(row => row.body?.length > 280) && <Button variant="ghost" size="sm" onClick={store.toggleExpand}>{state.expandAll ? "Collapse all" : "Expand all"}</Button>}
        {!all && !dm && <>
          {channel?.deliveryClass && <Badge variant="outline">{channel.deliveryClass}</Badge>}
          {channel?.replay !== undefined && <Badge variant="outline">{channel.replay ? `Replay ${channel.replayWindow || "on"}` : "Replay off"}</Badge>}
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm">Participants<ChevronDown data-icon="inline-end" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuLabel>Recent senders</DropdownMenuLabel>{state.members.length ? state.members.map(name => <DropdownMenuLabel key={name} className="font-normal">{name}</DropdownMenuLabel>) : <DropdownMenuLabel>No recent senders</DropdownMenuLabel>}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
          {state.channelDeleteSupported && <AlertDialogTrigger asChild><Button ref={deleteTrigger} variant="outline" size="sm"><Trash2 data-icon="inline-start" />Delete</Button></AlertDialogTrigger>}
        </>}
      </div>
    </div>
    {!dm && <OrderingNotice notes={state.orderNotes} />}
    <MessageScroller className="min-h-40">
      <MessageScrollerViewport aria-label={title}>
        <MessageScrollerContent className="mx-auto w-full max-w-4xl gap-6 p-6">
          {rows.map((row, index) => {
            const id = row.id ?? `${view}:${index}`;
            return <MessageScrollerItem key={id} messageId={id}><MessageRow row={row} state={state} /></MessageScrollerItem>;
          })}
          {!rows.length && <MessageScrollerItem messageId={`${view}:empty`}><Blank title={state.loading ? "Reading messages…" : "No messages yet"} description={all ? "Messages appear here as agents communicate across this space." : "Messages in this conversation will appear here."} /></MessageScrollerItem>}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton aria-label="Jump to latest" behavior="instant" />
    </MessageScroller>
    <TranscriptFooter paused={all && state.paused} />
    <AlertDialogContent aria-busy={deleting} onEscapeKeyDown={event => { if (deleting) event.preventDefault(); }} onCloseAutoFocus={event => { if (!deleteTrigger.current) { event.preventDefault(); titleElement.current?.focus(); } }}>
      <AlertDialogHeader><AlertDialogTitle>Delete #{state.selected}?</AlertDialogTitle><AlertDialogDescription>This permanently deletes the channel and all its messages. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
      {deleteError && <Alert variant="destructive" className="p-4"><TriangleAlert /><AlertTitle>Channel deletion failed</AlertTitle><AlertDescription>{deleteError}</AlertDescription></Alert>}
      <AlertDialogFooter><AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel><AlertDialogAction disabled={deleting} aria-label="Delete channel" onClick={event => { event.preventDefault(); void removeChannel(); }}>
        <span className="grid place-items-center"><span className={cn("col-start-1 row-start-1", deleting && "invisible")}>Delete channel</span>{deleting && <Spinner className="col-start-1 row-start-1" aria-label="Deleting channel" />}</span>
      </AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </section></MessageScrollerProvider></AlertDialog>;
}
function PauseControl({ paused }: { paused: boolean }) {
  const { scrollToEnd } = useMessageScroller();
  return <Hint label={paused ? "Resume following the feed. New messages continue to arrive." : "Keep your place while reading. Messages continue to arrive."}><Button variant="outline" size="sm" aria-label={paused ? "Resume auto-scroll" : "Pause auto-scroll"} onClick={() => { window.COTAL_DASHBOARD.togglePause(); if (paused) scrollToEnd({ behavior: "instant" }); }}>{paused ? <Play data-icon="inline-start" /> : <Pause data-icon="inline-start" />}{paused ? "Resume" : "Pause"}</Button></Hint>;
}
function TranscriptFooter({ paused }: { paused: boolean }) {
  const { scrollToEnd } = useMessageScroller();
  return <footer className="flex items-center justify-between gap-3 border-t px-6 py-2 text-xs text-muted-foreground"><span>{paused ? "Auto-scroll paused · messages still arriving" : "Recent history and live messages"}</span><Button variant="ghost" size="sm" onClick={() => scrollToEnd({ behavior: "instant" })}><ArrowDownToLine data-icon="inline-start" />Latest</Button></footer>;
}
function MessageRow({ row, state }: { row: Row; state: Snapshot }) {
  return <Message>
    <MessageContent>
      <MessageHeader className="flex-wrap gap-2"><span className="font-medium text-foreground">{row.whoName || row.who}</span>{row.role && <span>{row.role}</span>}{row.mode ? <Badge variant="secondary">{row.mode}</Badge> : row.status && <Status status={row.status} />}{row.target && <span>{row.target}</span>}</MessageHeader>
      <Bubble variant="ghost"><BubbleContent><MessageBody body={row.body || ""} expandAll={state.expandAll} /></BubbleContent></Bubble>
      <MessageFooter className="gap-2"><time>{row.ts}</time></MessageFooter>
    </MessageContent>
  </Message>;
}
