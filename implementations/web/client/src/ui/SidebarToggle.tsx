import { useEffect, useRef } from "react";
import { Separator } from "#client/ui/shadcn/separator.tsx";
import { SidebarTrigger, useSidebar } from "#client/ui/shadcn/sidebar.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#client/ui/shadcn/tooltip.tsx";

/** shadcn's SidebarTrigger and the rule after it, at the start of a view's header, where shadcn's
 *  sidebar blocks put them. On a phone it opens the places sheet and is named Open sidebar; wider it
 *  collapses the places to the icon rail and back, and is named Toggle sidebar. Its Tooltip repeats
 *  the name, and `aria-expanded` says whether what it opens is open.
 *
 *  The sheet has no SheetTrigger, so when it closes Radix puts the focus nowhere. The trigger takes
 *  it back instead, as a SheetTrigger would, whether the sheet closed on Escape, on the overlay or on
 *  a new route. */
export function SidebarToggle() {
  const { isMobile, open, openMobile } = useSidebar();
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(openMobile);
  useEffect(() => {
    if (wasOpen.current && !openMobile) trigger.current?.focus();
    wasOpen.current = openMobile;
  }, [openMobile]);
  const label = isMobile ? "Open sidebar" : "Toggle sidebar";
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarTrigger ref={trigger} aria-label={label} aria-haspopup={isMobile ? "dialog" : undefined} aria-expanded={isMobile ? openMobile : open} />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-auto" />
    </>
  );
}
