/**
 * `text` as a pattern that matches it and nothing else.
 *
 * One escape for every pattern built from someone else's words: the server's
 * message templates, a status-line template, the UI's own copy in a test. `/`
 * is escaped too, so the result can also stand inside a regex literal that a
 * harness sends to the page as source text.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
