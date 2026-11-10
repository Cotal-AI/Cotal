/**
 * Channel registry text as a surface prints it. A channel's description and instructions are
 * interpolated into lines the surface writes itself, and the text arrives checked only for type and
 * length (`validateChannelConfig`), from any writer, older ones included. A line break inside it would
 * start a line that reads as the surface's own, and a control character would reach a terminal as a
 * control sequence. These two helpers are the one rule every surface applies before it prints.
 */
import { LINE_BREAK } from "./peer-label.js";

/** Control code points, Unicode line and paragraph separators, and bidirectional formatting marks,
 *  which can make a line read in an order other than the one it is stored in. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu;

/** The text on one line: every line break, control character and bidirectional mark becomes a
 *  space. For the description, which is a one-line purpose, and for any surface that prints one line
 *  per channel. */
export function registryTextLine(text: string): string {
  return text.replace(CONTROL, " ");
}

/** The text split on every line break a reader may honour (`LINE_BREAK`), with any other control
 *  character or bidirectional mark in a line made a space. The caller indents every line after the
 *  first past its own structure, so no line of the text can pass for one the surface wrote. */
export function registryTextLines(text: string): string[] {
  return text.split(LINE_BREAK).map((line) => line.replace(CONTROL, " "));
}
