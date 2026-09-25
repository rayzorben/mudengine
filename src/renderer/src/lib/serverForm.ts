/**
 * The realm form's starting value. The form itself is `ServerDraft` as the
 * file states it, so a new realm is the one thing it needs beyond the draft.
 * The why is in `mudengine-settings`.
 */
import type { GlobalDraft, ServerDraft } from '@shared/drafts';
import { DEFAULT_LOCATE } from '@shared/locate';

/**
 * A realm that does not exist yet, started from the Global defaults.
 *
 * Same rule as `emptyForm`: the second realm on one BBS is otherwise the same
 * port, the same encoding and the same five menus typed a second time, and
 * every one of them can be got subtly wrong. The copy is taken here and
 * written into the realm's own file, so changing the defaults afterwards
 * changes what the *next* realm starts with.
 *
 * The host and the name are not carried, and that is the point rather than an
 * omission: they are what make it a different realm.
 */
export function emptyServerForm(defaults: GlobalDraft | null): ServerDraft {
  return {
    name: '',
    host: '',
    port: defaults?.connection.port || 23,
    encoding: defaults?.connection.encoding ?? 'cp437',
    login: (defaults?.connection.login.steps ?? []).map((step) => ({ ...step })),
    loops: [],
    // Empty is the world the client ships, which is right for a new realm until
    // somebody says otherwise. There is no Global default to copy: a map is a
    // fact about one place, so there is no sensible "next realm" value for it.
    database: '',
    // Nor for the monsters, and for exactly the same reason: a ranking names
    // this realm's own monsters, so there is nothing to carry from Global.
    mobRules: [],
    hangPenalties: null,
    // `rm` until somebody says the realm has none: what every realm was asked before.
    locate: DEFAULT_LOCATE,
    // No teleport until somebody writes this realm's own: it is never guessed.
    fleeGoto: ''
  };
}
