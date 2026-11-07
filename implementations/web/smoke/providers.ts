/** Wraps a part drawn on its own in the providers the app gives every view: the one TooltipProvider
 *  `Shell` holds and the SidebarProvider `AppShell` holds, so a Tooltip or a view header's
 *  SidebarToggle finds its context as it does in the page. */
import { createElement, type ReactElement } from "react";
import { SidebarProvider } from "../client/src/ui/shadcn/sidebar.tsx";
import { TooltipProvider } from "../client/src/ui/shadcn/tooltip.tsx";

export const inShell = (element: ReactElement): ReactElement =>
  createElement(TooltipProvider, null, createElement(SidebarProvider, null, element));
