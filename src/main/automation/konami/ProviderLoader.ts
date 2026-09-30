/**
 * Finding the decision provider on disk and asking it within a time limit.
 *
 * The provider is an ES module the player points at (`konamiProviderPath`),
 * or one dropped under `<home>/extensions/konami/`. It exports `provider` or a
 * default: `{ name, ask({ state, questions }) }`. Nothing about it is compiled
 * into this client, so a missing or broken one is a refusal said out loud,
 * never a crash and never a silent fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { t } from '../../app/i18n';
import {
  asKonamiReply,
  type KonamiAsk,
  type KonamiProvider,
  type KonamiReply
} from '../../../shared/konami';
import { errorMessage } from '../../../shared/values';

export type LoadResult = { provider: KonamiProvider } | { refusal: string };

/** Where a provider is looked for: the configured path first, then the extensions folder. */
export function providerPaths(configured: string, home: string | null): string[] {
  const list: string[] = [];
  if (configured.trim().length > 0) list.push(configured.trim());
  if (home !== null) {
    const dir = path.join(home, 'extensions', 'konami');
    list.push(path.join(dir, 'index.js'), path.join(dir, 'index.mjs'));
  }
  return list;
}

function isProvider(value: unknown): value is KonamiProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { ask?: unknown }).ask === 'function'
  );
}

/** The first candidate that exists and exports a provider, or why none did. */
export async function loadProvider(candidates: readonly string[]): Promise<LoadResult> {
  const problems: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const module = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
      const found = module['provider'] ?? module['default'];
      if (isProvider(found)) return { provider: found };
      problems.push(t('automation.konami.notAProvider', { file: candidate }));
    } catch (error) {
      problems.push(
        t('automation.konami.loadFailed', { file: candidate, error: errorMessage(error) })
      );
    }
  }
  return {
    refusal:
      problems.length > 0
        ? problems.join(' ')
        : t('automation.konami.noProvider', { paths: candidates.join(', ') })
  };
}

/**
 * The provider's reply, parsed against the questions asked, or why there is
 * none. A reply that does not answer what was asked is a refusal: a plan read
 * half from it would act on a guess.
 */
export async function askWithin(
  provider: KonamiProvider,
  request: KonamiAsk,
  ms: number
): Promise<{ reply: KonamiReply; raw: unknown } | { refusal: string }> {
  let timer: NodeJS.Timeout | null = null;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms);
  });
  try {
    const raw = await Promise.race([provider.ask(request), late]);
    if (raw === 'late') return { refusal: t('automation.konami.timedOut', { seconds: ms / 1000 }) };
    const reply = asKonamiReply(raw, request.questions);
    return reply === null
      ? { refusal: t('automation.konami.badReply', { provider: provider.name }) }
      : { reply, raw };
  } catch (error) {
    return {
      refusal: t('automation.konami.askFailed', {
        provider: provider.name,
        error: errorMessage(error)
      })
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
