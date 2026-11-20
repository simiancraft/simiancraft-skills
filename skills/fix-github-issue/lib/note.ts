/**
 * The marker on a loop comment that carries no other: a sweep's cleanup note, a park reason, or a
 * hold's reason. Every comment the loop writes opens with a marker, so a reader can tell the loop's
 * bookkeeping from a person's word by the text alone, whichever account the loop runs under.
 */

export const LOOP_NOTE = '<!-- loop-note -->';

/** The body with the loop-note marker first, unless it already opens with a marker. */
export function loopNote(body: string): string {
  return body.trimStart().startsWith('<!--') ? body : `${LOOP_NOTE}\n${body}`;
}
