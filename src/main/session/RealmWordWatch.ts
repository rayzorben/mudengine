/**
 * The realm has said which data it runs, and whether this session is walking
 * it. `CharacterState.realm` is the menu prompt's own word, and it is the one
 * place the wire says which of the two bundled worlds this is
 * (`shared/worlds.ts`). Told to the sink once per connection so the address is
 * remembered; and compared with the world this session was built on, because
 * that was chosen before anything was dialled. A disagreement is said once and
 * not resolved here (the world is bound for the session's life), so the
 * sentence says what to do about it. A player's own database names no bundled
 * world and is theirs: nothing is said about it.
 */
import type { CharacterState, RealmFamily as RealmWord } from '../../shared/character';
import { SHIPPED_WORLD_LABEL, worldOfRealm } from '../../shared/worlds';
import { t } from '../app/i18n';
import type { WorldGraph } from '../world/WorldGraph';
import type { SessionSink } from './SessionSink';

export class RealmWordWatch {
  /** The realm's own word for its data, once the menu has said it. */
  private told: RealmWord | null = null;

  constructor(
    private readonly world: Pick<WorldGraph, 'info'> | undefined,
    private readonly sink: Pick<SessionSink, 'realmTold' | 'notice'>
  ) {}

  note(state: CharacterState): void {
    if (state.realm === null || state.realm === this.told) return;
    this.told = state.realm;
    this.sink.realmTold?.(state.realm);
    const wanted = worldOfRealm(state.realm);
    const loaded = this.world?.info.world ?? null;
    if (wanted === null || loaded === null || wanted === loaded) return;
    this.sink.notice(
      t('session.realm.worldDisagrees', {
        realm: SHIPPED_WORLD_LABEL[wanted],
        world: SHIPPED_WORLD_LABEL[loaded]
      })
    );
  }

  /** A new connection: the menu says it again. */
  forget(): void {
    this.told = null;
  }
}
