/**
 * What passes between an extension's card and the page it frames (todo 84),
 * both ways, by `postMessage`. The page is its own origin in a sandbox, so
 * these messages are all it has of the client: the view its extension
 * publishes and the theme's tokens one way, its buttons the other.
 */
import { isRecord } from '@shared/values';

/** To the page: what to draw, and what a button it pressed came to. */
export type CardToExtension =
  | {
      type: 'mudengine:view';
      session: string;
      view: unknown;
      /** Every custom property on the window's root, so the page wears the theme. */
      theme: Record<string, string>;
    }
  | {
      type: 'mudengine:result';
      id: number;
      result: { value: unknown } | { refusal: string };
    };

/** From the page: it has loaded, or a button was pressed. */
export type ExtensionToCard =
  | { type: 'mudengine:ready' }
  | { type: 'mudengine:action'; id: number; action: string; args: unknown[] };

/** A message from the page, or null where it is not one of these. */
export function extensionMessage(data: unknown): ExtensionToCard | null {
  if (!isRecord(data)) return null;
  if (data['type'] === 'mudengine:ready') return { type: 'mudengine:ready' };
  if (data['type'] !== 'mudengine:action') return null;
  const { id, action, args } = data;
  if (typeof id !== 'number' || typeof action !== 'string') return null;
  return { type: 'mudengine:action', id, action, args: Array.isArray(args) ? args : [] };
}

/** The theme as the window wears it: each `--token` on the root and its value. */
export function themeTokens(root: Element): Record<string, string> {
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    if (name.startsWith('--')) tokens[name] = style.getPropertyValue(name).trim();
  }
  return tokens;
}
