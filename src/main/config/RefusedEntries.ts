/**
 * What the options file and each character's file state that does not load,
 * said when the file is read (todo 74): an alias the realm's own word
 * shadows, a key the client already uses, two entries on one key, a list
 * that is not lines, or a macro that reaches itself, a character's through
 * Global's too (todo 134), and a room name of the options file's `rooms:`
 * list (todo 153). Said once per change of what is refused, so the
 * twice-a-second reload of an unchanged file says nothing again.
 */
import { aliasRefusalText, refusedAliases } from '../../shared/aliases';
import { keyRefusalText, readKeys } from '../../shared/keys';
import { macroBlocks } from '../../shared/profiles';
import { loopingIn } from '../../shared/macroBook';
import {
  asRoomNicknames,
  refusedEntryName,
  roomNameFaultText,
  type RoomNameRefusal
} from '../../shared/roomNicknames';
import { isRecord } from '../../shared/values';
import { t } from '../app/i18n';

export class RefusedEntries {
  /** What was last said, by file: `''` for the options file, a character's id for its own. */
  private readonly said = new Map<string, string>();

  /** The notices for `source` (the options file as parsed), or none when nothing changed. */
  fresh(source: unknown): string[] {
    const file = isRecord(source) ? source : {};
    const automation = isRecord(file['automation']) ? file['automation'] : {};
    const looping = loopingIn(file['keys'], automation['aliases']);
    const rooms: RoomNameRefusal[] = [];
    asRoomNicknames(file['rooms'], (refusal) => rooms.push(refusal));
    return this.once('', [
      ...refusedAliases(automation['aliases'], looping).map(({ name, refusal }) =>
        t('app.config.refusedAlias', { name, reason: aliasRefusalText(refusal, t) })
      ),
      ...readKeys(file['keys'], looping).refused.map(({ name, refusal }) =>
        t('app.config.refusedKey', { name, reason: keyRefusalText(refusal, t) })
      ),
      ...rooms.map((refusal) =>
        t('app.config.refusedRoomName', {
          code: refusedEntryName(refusal),
          reason: roomNameFaultText(refusal.fault, t)
        })
      )
    ]);
  }

  /**
   * The notices for one character's file (`raw`, as parsed) over the options
   * file (`base`, as parsed): each entry of its own that is refused, with why,
   * and each key or alias that loops only once the two are laid together.
   */
  freshFor(id: string, character: string, raw: unknown, base: unknown): string[] {
    const file = isRecord(raw) ? raw : {};
    const automation = isRecord(file['automation']) ? file['automation'] : {};
    const options = isRecord(base) ? base : {};
    const blocks = macroBlocks(raw, base);
    const looping = loopingIn(blocks.keys, blocks.aliases);
    const alone = loopingIn(
      options['keys'],
      isRecord(options['automation']) ? options['automation']['aliases'] : undefined
    );
    const theirs = [...looping].filter((name) => !alone.has(name));
    const alias = (name: string, reason: string): string =>
      t('app.config.refusedCharacterAlias', { character, name, reason });
    const key = (name: string, reason: string): string =>
      t('app.config.refusedCharacterKey', { character, name, reason });
    return this.once(id, [
      ...refusedAliases(automation['aliases']).map(({ name, refusal }) =>
        alias(name, aliasRefusalText(refusal, t))
      ),
      ...readKeys(file['keys'])
        .refused.filter(({ refusal }) => refusal !== 'empty')
        .map(({ name, refusal }) => key(name, keyRefusalText(refusal, t))),
      ...theirs
        .filter((name) => Object.hasOwn(asMap(blocks.keys), name))
        .map((name) => key(name, keyRefusalText('loops', t))),
      ...theirs
        .filter((name) => Object.hasOwn(asMap(blocks.aliases), name))
        .map((name) => alias(name, aliasRefusalText('loops', t)))
    ]);
  }

  private once(file: string, messages: string[]): string[] {
    const key = messages.join('\n');
    if (key === (this.said.get(file) ?? '')) return [];
    this.said.set(file, key);
    return messages;
  }
}

function asMap(block: unknown): Record<string, unknown> {
  return isRecord(block) ? block : {};
}
