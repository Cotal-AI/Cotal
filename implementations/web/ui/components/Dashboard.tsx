import { useEffect, useState, useSyncExternalStore } from "react";
import { Bell, CircleDot, RefreshCw, TriangleAlert } from "lucide-react";
import { useDefaultLayout, useGroupRef } from "react-resizable-panels";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { Navigation } from "./dashboard/navigation";
import { Transcript } from "./dashboard/transcript";
import { AgentDetails, Attention } from "./dashboard/details";
import { Status } from "./dashboard/primitives";
import type { Snapshot } from "@/lib/dashboard-types";

export default function Dashboard() {
  const store = window.COTAL_DASHBOARD;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <TooltipProvider><SidebarProvider className="h-svh min-h-0 overflow-hidden"><Workspace state={state} /></SidebarProvider><Toaster /></TooltipProvider>;
}
function Workspace({ state }: { state: Snapshot }) {
  const { isMobile, open } = useSidebar();
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [attentionHidden, setAttentionHidden] = useState(false);
  const showRail = wide && !attentionHidden && (state.waiting.length > 0 || attentionOpen);
  const shellPanelIds = [...(!isMobile && open ? ["navigation"] : []), "workspace"];
  const shellPanels = useGroupRef();
  const shellLayout = useDefaultLayout({ id: "cotal.dashboard.shell", panelIds: shellPanelIds });
  const resetNavigation = () => shellPanels.current?.setLayout(open ? { navigation: 20, workspace: 80 } : { workspace: 100 });
  const panelIds = ["content", ...(showRail ? ["attention"] : [])];
  const panels = useGroupRef();
  const resetLayout = () => panels.current?.setLayout(showRail ? { content: 72, attention: 28 } : { content: 100 });
  const layout = useDefaultLayout({ id: "cotal.dashboard.conversation", panelIds });
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() { setRefreshing(true); try { await window.COTAL_DASHBOARD.refresh(); } finally { setRefreshing(false); } }
  const current = state.agentSel ? state.agent?.card.name ?? "Agent" : state.dmSel ? "Direct messages" : state.selected === "*" ? "Activity" : state.selected ?? "Activity";
  const attentionButton = <Button variant="outline" size="sm" onClick={() => { if (wide) { setAttentionHidden(showRail); setAttentionOpen(!showRail); } }} aria-expanded={wide ? showRail : attentionOpen} aria-label={`Needs you ${state.waiting.length} waiting`}><Bell data-icon="inline-start" /><span className="hidden sm:inline">Needs you</span>{" "}<span className="tabular-nums">{state.waiting.length}</span></Button>;
  return <Sheet open={attentionOpen} onOpenChange={setAttentionOpen}><div className="flex h-full w-full min-w-0">
    <ResizablePanelGroup orientation="horizontal" groupRef={shellPanels} {...shellLayout} className="h-full min-h-0">
      {!isMobile && open && <><ResizablePanel id="navigation" defaultSize="256px" minSize="240px" maxSize="360px"><Navigation state={state} /></ResizablePanel><ResizableHandle aria-label="Resize navigation" onDoubleClick={resetNavigation} /></>}
      <ResizablePanel id="workspace" minSize={isMobile ? "100%" : "400px"}><div className="flex h-full min-w-0 flex-col">
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
      <SidebarTrigger /><Separator orientation="vertical" className="h-4" />
      <Breadcrumb className="mr-auto min-w-0"><BreadcrumbList className="flex-nowrap"><BreadcrumbItem className="hidden sm:inline-flex"><BreadcrumbLink href="/">{state.space}</BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator className="hidden sm:block" /><BreadcrumbItem className="min-w-0"><BreadcrumbPage className="truncate">{current}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
      <Badge variant="outline"><CircleDot data-icon="inline-start" />{state.connected ? "Live" : "Disconnected"}</Badge>
      <span className="hidden lg:inline"><Badge variant="secondary">{state.channelDeleteSupported ? "Operator" : "Read-only"}</Badge></span>
      <Button variant="ghost" size="icon-sm" aria-label="Refresh dashboard" disabled={refreshing} onClick={() => void refresh()}><RefreshCw /></Button>
      {wide ? attentionButton : <SheetTrigger asChild>{attentionButton}</SheetTrigger>}
      <Button variant="ghost" size="sm" asChild><a href="/graph">Graph</a></Button>
    </header>
    <ResizablePanelGroup orientation="horizontal" groupRef={panels} {...layout} className="min-h-0 flex-1">
      <ResizablePanel id="content" minSize={isMobile ? "100%" : "400px"}>
        <main className="flex h-full min-h-0 flex-col overflow-y-auto">
          <dl className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 border-b px-6 py-4" aria-label="Mesh status">
            {["working","waiting","idle","offline","heartbeat"].map(status => <div key={status} className="flex items-center gap-2 whitespace-nowrap text-sm">
              <dt className="flex items-center gap-2 text-muted-foreground">{status !== "heartbeat" && <span aria-hidden="true"><Status status={status} /></span>}{status === "heartbeat" ? "Oldest heartbeat" : status[0].toUpperCase() + status.slice(1)}</dt>
              <dd className="font-medium tabular-nums">{status === "heartbeat" ? state.stalest : state.counts[status]}</dd>
            </div>)}
          </dl>
          {state.stale.length > 0 && <div className="shrink-0 px-6 pt-4"><Alert variant="destructive" className="p-4"><TriangleAlert /><AlertTitle>Some sources are stale</AlertTitle><AlertDescription><p>The last available data is shown.</p><ul className="flex flex-col gap-1">{state.stale.map(item => <li key={item.name}>{item.name}: {item.reason}</li>)}</ul></AlertDescription></Alert></div>}
          <div className="min-h-[32rem] flex-1">{state.agentSel ? <AgentDetails state={state} /> : <Transcript state={state} />}</div>
        </main>
      </ResizablePanel>
      {showRail && <><ResizableHandle aria-label="Resize attention panel" onDoubleClick={resetLayout} /><ResizablePanel id="attention" defaultSize="288px" minSize="260px" maxSize="360px"><Attention state={state} /></ResizablePanel></>}
    </ResizablePanelGroup>
      </div></ResizablePanel>
    </ResizablePanelGroup>
    {isMobile && <Navigation state={state} />}
    {!wide && <SheetContent><SheetHeader><SheetTitle>Needs you</SheetTitle><SheetDescription>Agents waiting for your input</SheetDescription></SheetHeader><Attention state={state} onSelect={() => setAttentionOpen(false)} showHeader={false} /></SheetContent>}
  </div></Sheet>;
}
