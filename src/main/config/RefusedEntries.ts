/**
 * What the options file states that does not load, said when the file is read
 * (todo 74): an alias the realm's own word shadows, a key the client already
 * uses or two entries on one key. Said once per change of what is refused, so
 * the twice-a-second reload of an unchanged file says nothing again.
 */
import { aliasRefusalText, refusedAliases } from '../../shared/aliases';
import { keyRefusalText, readKeys } from '../../shared/keys';
import { isRecord } from '../../shared/values';
import { t } from '../app/i18n';

export class RefusedEntries {
  private said = '';

  /** The notices for `source` (the options file as parsed), or none when nothing changed. */
  fresh(source: unknown): string[] {
    const file = isRecord(source) ? source : {};
    const automation = isRecord(file['automation']) ? file['automation'] : {};
    const messages = [
      ...refusedAliases(automation['aliases']).map(({ name, refusal }) =>
        t('app.config.refusedAlias', { name, reason: aliasRefusalText(refusal, t) })
      ),
      ...readKeys(file['keys']).refused.map(({ name, refusal }) =>
        t('app.config.refusedKey', { name, reason: keyRefusalText(refusal, t) })
      )
    ];
    const key = messages.join('\n');
    if (key === this.said) return [];
    this.said = key;
    return messages;
  }
}
