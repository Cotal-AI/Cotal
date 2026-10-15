import { createContext } from "react";

/** The shell's `selectAgent`, for components that sit too deep to be handed it: a message row's
 *  avatar and name. Null outside the shell, where picking an agent opens nothing and the row draws
 *  plain text. */
export const AgentPicker = createContext<((id: string) => void) | null>(null);
