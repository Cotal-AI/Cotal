import { ChevronDown, Hash, MessagesSquare, Radio, Users } from "lucide-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useDefaultLayout, useGroupRef } from "react-resizable-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { Blank, Harness, Status, text } from "./primitives";
import type { Snapshot } from "@/lib/dashboard-types";

export function Navigation({ state }: { state: Snapshot }) {
  const store = window.COTAL_DASHBOARD;
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = (action: () => void) => { action(); if (isMobile) setOpenMobile(false); };
  const panels = useGroupRef();
  const reset = () => panels.current?.setLayout({agents:38, channels:34, dms:28});
  const layout = useDefaultLayout({ id: "cotal.dashboard.navigation", panelIds: ["agents", "channels", "dms"] });
  const online = state.roster.filter(p => p.status !== "offline").sort((a,b) => ["working","waiting","idle"].indexOf(a.status)-["working","waiting","idle"].indexOf(b.status) || a.card.name.localeCompare(b.card.name));
  const hosts = [...new Set(online.map(p => text(p.card.meta?.host)))].sort((a,b) => Number(!a)-Number(!b) || a.localeCompare(b));
  return <Sidebar collapsible={isMobile ? "offcanvas" : "none"} className="w-full min-w-0">
    <SidebarHeader className="gap-1 px-5 py-5">
      <a href="/" className="flex items-center gap-2 font-semibold tracking-tight"><Radio className="size-5" aria-hidden="true" />Cotal</a>
      <span className="pl-7 text-xs text-muted-foreground">{state.space} <span aria-hidden="true">/</span> Mesh dashboard</span>
    </SidebarHeader>
    <SidebarContent className="overflow-hidden">
      <ResizablePanelGroup orientation="vertical" groupRef={panels} {...layout}>
        <ResizablePanel id="agents" defaultSize="38%" minSize="100px">
          <SidebarGroup className="h-full">
            <SidebarGroupLabel className="gap-2"><Users data-icon="inline-start" />Online agents<span className="ml-auto tabular-nums">{online.length}</span></SidebarGroupLabel>
            <ScrollArea className="min-h-0 flex-1"><SidebarGroupContent><SidebarMenu>
              {state.loading && !online.length && <div className="flex flex-col gap-3 p-3"><Skeleton className="h-7 w-full" /><Skeleton className="h-7 w-4/5" /></div>}
              {hosts.map(host => <li key={host} className="list-none">
                <p className="flex items-center justify-between gap-2 px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground"><span className="truncate">{host || "Host not reported"}</span><span>{online.filter(p => text(p.card.meta?.host) === host).length}</span></p>
                <SidebarMenu>{online.filter(p => text(p.card.meta?.host) === host).map(p => { const wording = window.COTAL_PRESENCE.describe(p); return <SidebarMenuItem key={p.card.id}>
                  <SidebarMenuButton size="lg" isActive={state.agentSel === p.card.id} onClick={() => navigate(() => store.selectAgent(p.card.id))} title={[wording.status, wording.activity, wording.heartbeat].filter(Boolean).join(" · ")} className="h-auto py-2" aria-pressed={state.agentSel === p.card.id}>
                    <Status status={p.status} /><span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="flex items-center gap-2"><span className="truncate font-medium">{p.card.name}</span><Harness compact connector={p.card.meta?.connector} /><span className="truncate text-xs text-muted-foreground">{p.card.role}</span>{p.attention && p.attention !== "open" && <Badge variant="outline">{p.attention}</Badge>}</span><span className="truncate text-xs text-muted-foreground">{wording.status}</span><span className="truncate text-xs text-muted-foreground">{wording.activity || "No current activity reported"}</span></span>
                  </SidebarMenuButton>
                </SidebarMenuItem>; })}</SidebarMenu>
              </li>)}
              {!state.loading && !online.length && <li><Blank title="No agents online" description="Agents appear here when they join the space." /></li>}
            </SidebarMenu></SidebarGroupContent></ScrollArea>
          </SidebarGroup>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize agents and channels" onDoubleClick={reset} />
        <ResizablePanel id="channels" defaultSize="34%" minSize="120px">
          <SidebarGroup className="h-full"><SidebarGroupLabel className="gap-2"><Hash data-icon="inline-start" />Channels<span className="ml-auto tabular-nums">{state.channels.length}</span></SidebarGroupLabel>
            <ScrollArea className="min-h-0 flex-1"><SidebarGroupContent><SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton isActive={state.selected === "*"} aria-pressed={state.selected === "*"} onClick={() => navigate(() => { void store.select("*"); })} aria-label="All activity"><Radio /><span>All activity</span></SidebarMenuButton><SidebarMenuBadge aria-label={`${state.channels.reduce((sum, ch) => sum + (ch.messages ?? 0), 0)} channel messages`}>{state.channels.reduce((sum, ch) => sum + (ch.messages ?? 0), 0)}</SidebarMenuBadge></SidebarMenuItem>
              {state.channels.map(ch => <SidebarMenuItem key={ch.name}><SidebarMenuButton className="pr-14" isActive={state.selected === ch.name} aria-pressed={state.selected === ch.name} aria-label={`Channel ${ch.name}`} onClick={() => navigate(() => { void store.select(ch.name); })}>
                <Hash /><span>{ch.name}</span>
              </SidebarMenuButton><SidebarMenuBadge className="gap-2"><span aria-label={`${ch.messages ?? 0} messages`}>{ch.messages ?? 0}</span>{ch.unread > 0 && <Badge aria-label={`${ch.unread} unread ${ch.unread === 1 ? "message" : "messages"}`}>{ch.unread}</Badge>}</SidebarMenuBadge></SidebarMenuItem>)}
            </SidebarMenu></SidebarGroupContent></ScrollArea>
          </SidebarGroup>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize channels and direct messages" onDoubleClick={reset} />
        <ResizablePanel id="dms" defaultSize="28%" minSize="100px">
          <SidebarGroup className="h-full"><SidebarGroupLabel className="gap-2"><MessagesSquare data-icon="inline-start" />Direct messages</SidebarGroupLabel>
            <ScrollArea className="min-h-0 flex-1"><SidebarGroupContent><SidebarMenu>
              {state.dmPeers.map(p => <Collapsible key={p.id} open={state.dmSel?.peer === p.id} asChild><SidebarMenuItem>
                <CollapsibleTrigger asChild><SidebarMenuButton aria-label={`Direct messages ${p.name}, ${p.threads} threads`} onClick={() => navigate(() => store.selectDM(p.id))}><Status status={p.status} /><span>{p.name}</span><ChevronDown className="ml-auto" /></SidebarMenuButton></CollapsibleTrigger>
                <CollapsibleContent><SidebarMenu className="pl-4">{p.conversations.map(c => <SidebarMenuItem key={c.with}><SidebarMenuButton isActive={state.dmSel?.peer === p.id && state.dmSel.with === c.with} aria-pressed={state.dmSel?.peer === p.id && state.dmSel.with === c.with} onClick={() => navigate(() => store.selectDM(p.id,c.with))}><span>↳</span><span>{c.withName || c.with}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></CollapsibleContent>
              </SidebarMenuItem></Collapsible>)}
              {!state.dmPeers.length && <li><Blank title="No direct messages" description="Conversations appear here when agents exchange messages." /></li>}
            </SidebarMenu></SidebarGroupContent></ScrollArea>
          </SidebarGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </SidebarContent>
    <SidebarFooter className="px-5 py-3 text-[10px] text-muted-foreground">{state.channelDeleteSupported ? "Operator session" : "Read-only session"}<span>Live mesh observability</span></SidebarFooter>
  </Sidebar>;
}
