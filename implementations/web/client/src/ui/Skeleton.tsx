import { SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuSkeleton } from "#client/ui/shadcn/sidebar.tsx";
import { Skeleton } from "#client/ui/shadcn/skeleton.tsx";

/** The places the skeleton stands in for: Needs you and Activity under no heading, then three
 *  channels and a conversation under theirs. */
const PLACES: { heading?: string; rows: number }[] = [{ rows: 2 }, { heading: "Channels", rows: 3 }, { heading: "Direct messages", rows: 1 }];

/** One skeleton message: an avatar square and a bar per line, `lines` the bars' widths. */
function Message({ lines }: { lines: string[] }) {
  return (
    <div className="ui-skel-msg">
      <Skeleton className="size-8.5" />
      <div style={{ display: "grid", gap: 8, paddingTop: 4 }}>
        {lines.map((w, i) => <Skeleton key={i} className="h-2.5" style={{ width: w }} />)}
      </div>
    </div>
  );
}

/** The sidebar's places while the first reads are outstanding (mock section B, Loading): shadcn's
 *  sidebar menu skeleton, an icon and a bar of its own width, two where Needs you and Activity go,
 *  then the Channels and Direct messages headings over theirs. The bars are drawing, not content, so
 *  assistive tech skips them and the list says it is busy. */
export function SkeletonPlaces() {
  return (
    <SidebarContent role="navigation" aria-label="Places" aria-busy="true">
      {PLACES.map(({ heading, rows }) => (
        <SidebarGroup key={heading ?? ""} aria-hidden="true">
          {heading && <SidebarGroupLabel>{heading}</SidebarGroupLabel>}
          <SidebarMenu>
            {Array.from({ length: rows }, (_, i) => (
              <SidebarMenuItem key={i}>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </SidebarContent>
  );
}

/** The centre while the first reads are outstanding (mock section B, Loading): a bar where the
 *  view's title goes and two skeleton messages. */
export function SkeletonView() {
  return (
    <div aria-hidden="true" style={{ display: "contents" }}>
      <header className="ui-bar"><Skeleton className="h-3 w-30" /></header>
      <div className="ui-col" style={{ width: "100%" }}>
        <Message lines={["30%", "85%"]} />
        <Message lines={["24%", "70%", "52%"]} />
      </div>
    </div>
  );
}
