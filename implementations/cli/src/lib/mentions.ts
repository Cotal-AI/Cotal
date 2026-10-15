/** @-mentions inside a message body → bare names (priority/wake hint). Shared by the console
 *  palette and the headless `cotal msg` so both carry the same wake hints on a multicast. It lives
 *  in core so the dashboard's composer derives them the same way. */
export { mentionsIn } from "@cotal-ai/core";
