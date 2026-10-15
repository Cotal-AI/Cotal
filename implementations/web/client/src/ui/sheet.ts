import { createContext } from "react";

/** The places sheet on a phone, for the channel header's menu button: whether the sheet is open and
 *  the way to open it. Null in the wide layout, where the sidebar is always drawn and the header has
 *  no menu button. */
export const SheetMenu = createContext<{ open: boolean; show(): void } | null>(null);
