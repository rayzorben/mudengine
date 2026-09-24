import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import BentoCard, { type CardChrome, type CardFilter } from './BentoCard';
import { FindField } from './CardTable';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import NamedText from './NamedText';
import type { NameIndex } from '../lib/names';
import { isKnownPlayer, isOwnName, PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import { matches } from '../lib/table';
import { tuning } from '../lib/tuning';
import { linkify } from '../lib/linkify';
import { useRemembered, useRememberedChoice } from '../hooks/useRemembered';
import {
  compose,
  DEFAULT_TALK_LAYOUT,
  DEFAULT_TALK_STAMP,
  formatTalkStamp,
  talkChannel,
  TALK_CHANNELS,
  TALK_PRESENCE_TYPES,
  type TalkChannel,
  type TalkLayout,
  type TalkStamp
} from '@shared/talk';
import type { SessionId } from '@shared/ipc';
import type { CharacterState } from '@shared/character';
import type { Block } from '@shared/blocks';
import { parseMacro } from '@shared/macro';

export interface ConversationCardProps extends CardChrome {
  /** What this character's card carries (`isTalkBlock`), oldest first. */
  messages: Block[];
  /** Which character's card this is, so its filters are remembered per character. */
  session: SessionId;
  /**
   * Sends a line, exactly as typing it into the console would.
   *
   * Not a special conversation channel: it goes down the same path a keystroke
   * does, so the tracker sees the command, a walk in progress stands down, the
   * capture records it and a password would be redacted. A second way to reach
   * the socket is a second set of those rules to keep, and they would drift.
   *
   * Absent when there is nothing to send to — an offline character gets the
   * backlog without a composer, rather than a box that silently does nothing.
   */
  onSend?(line: string): void;
  /**
   * A line of several commands (`parseMacro`), handed to main as typed, which
   * parses it again and paces it by the prompt (todo 04). With `onSend`.
   */
  onMacro?(line: string): void;
  /** How many of the box's commands are still waiting their turn in main. */
  macroQueued?: number;
  /** Drops them. */
  onDropMacro?(): void;
  /**
   * The name on a line clicked: the Player flyout on them, beside the line.
   * Usually the speaker; on this character's own receipts (`--- Telepath Sent
   * to X ---`, a directed say) the name is the *recipient*, and the registry
   * deliberately files neither — so a name is a control only when the
   * registry or the roster knows the person, never because a line carried it.
   */
  onSelect?(name: string, anchor: PopoverAnchor): void;
  /** Whose card this is, for the test of which names are people, and which is this character. */
  character?: CharacterState;
  /**
   * The console's own name index, for the `original` layout.
   *
   * That layout quotes the realm's whole sentence rather than the three parts
   * the condensed ones draw, so the speaker is inside the text and cannot be a
   * control of its own. The Alerts card had this problem first and the answer
   * is the same one: run the sentence through the index the console uses, so a
   * card and the console cannot disagree about what is a name.
   */
  names?: NameIndex | null;
  /** A monster's, an item's or a spell's name clicked in a quoted sentence. */
  inspect?(name: string, anchor: HTMLElement): void;
}

/**
 * The channels, and what each is called where a person can read it.
 *
 * Keyed by block type so a new channel added to the parser shows up here by
 * adding one line, and an unknown one still renders under its own name rather
 * than vanishing.
 *
 * Six of these words also name the same channels in the composer's picker
 * (`TALK_CHANNELS[].label`, which cannot read the dictionary because
 * `src/shared` stays dependency-free); `__tests__/conversation.test.ts`
 * asserts the two vocabularies agree, so a rewording of either fails loudly.
 */
const CHANNELS: Record<string, string> = {
  'conversation-gossip': t('cards.talk.channels.gossip'),
  'conversation-broadcast': t('cards.talk.channels.broadcast'),
  'conversation-telepath': t('cards.talk.channels.telepath'),
  'conversation-gangpath': t('cards.talk.channels.gang'),
  'conversation-auction': t('cards.talk.channels.auction'),
  'conversation-yell': t('cards.talk.channels.yell'),
  'conversation-local': t('cards.talk.channels.say'),
  // An emote, read off the server's action table: the actor is the `who`
  // column and `message` is the sentence with the actor taken off its front.
  'conversation-action': t('cards.talk.channels.action'),
  /*
   * Both directions land here: `Soul says (to you) "..."` arriving, and the
   * `--- Message Directed to Soul ---` receipt for one sent from this card.
   * "to you" was true of only the first of the two.
   */
  'conversation-directed': t('cards.talk.channels.direct'),
  /*
   * The comings and goings. Not channels the composer can be pointed at —
   * nobody says anything on them — so they are absent from `TALK_CHANNELS`
   * and the vocabulary test that pairs the two tables walks that list, not
   * this one. Each is named by what happened, because the column beside it
   * names the person and the realm's sentence is the same three words every
   * time.
   */
  'player-enters': t('cards.talk.channels.entered'),
  'player-exits': t('cards.talk.channels.left'),
  'player-disconnects': t('cards.talk.channels.disconnected')
};

/**
 * The card's channel toggles, in the heading where the mute chips used to
 * spend a row of the body.
 *
 * **Toggles and not faces** (2026-09-10, todo 06). They were faces, which
 * means exactly one is showing — so watching gossip *and* the gang meant
 * watching everything, and *these two and not the rest* could not be said at
 * all, which is the one question a channel list is asked. `All` is the master:
 * on, every channel is drawn and the rest are disabled **in their own state**,
 * because *All is on* is a different fact from *this one is off* and turning
 * All back off has to put the reader's own choices back.
 *
 * `local` folds the three channels that are the same conversation — what is
 * said in the room reaches the same ears whether it was said, yelled or
 * directed. A toggle appears only while its channel has said something, the
 * same rule the chips followed: a control over nothing is chrome.
 */
const FACES: ReadonlyArray<{ id: string; label: string; types: readonly string[] | null }> = [
  { id: 'talk', label: t('cards.talk.tabs.all'), types: null },
  { id: 'gossip', label: t('cards.talk.tabs.gossip'), types: ['conversation-gossip'] },
  { id: 'auction', label: t('cards.talk.tabs.auction'), types: ['conversation-auction'] },
  { id: 'broadcast', label: t('cards.talk.tabs.broadcast'), types: ['conversation-broadcast'] },
  { id: 'gang', label: t('cards.talk.tabs.gang'), types: ['conversation-gangpath'] },
  { id: 'telepath', label: t('cards.talk.tabs.telepath'), types: ['conversation-telepath'] },
  {
    id: 'local',
    label: t('cards.talk.tabs.local'),
    // An emote reaches the same ears a said line does, so it is local too.
    types: [
      'conversation-yell',
      'conversation-local',
      'conversation-directed',
      'conversation-action'
    ]
  },
  /*
   * Who arrived and who went, folded into one face the way `local` folds the
   * three that are the same conversation: entering, leaving and dropping the
   * line are one question — who is about — and three pills for it would be
   * three controls over one answer.
   */
  { id: 'realm', label: t('cards.talk.tabs.realm'), types: TALK_PRESENCE_TYPES }
];

const FACE_IDS = FACES.map((face) => face.id);
/** Every toggle but the master, which is the set a reader can mute. */
const CHANNEL_IDS = FACE_IDS.slice(1);
/** The master's two remembered words. See the card's own note. */
const ALL_WORDS = ['on', 'off'] as const;

/**
 * The two channels whose lines can be this character's own outbound half.
 *
 * A receipt (`--- Telepath Sent to Brackle ---`) names the *recipient* in
 * `player` and carries no `message` — the server never echoes the body. The
 * classifier binds what was actually said into `sent` from the command that
 * provoked the receipt, and the card says the direction: `telepath to
 * Brackle: bitch`, not the framing of a confirmation. A receipt the
 * classifier could not bind — two telepaths in flight at once — still states
 * the direction, with the server's own line where the body would be, because
 * a body invented for it would be the client misquoting its own player.
 */
const RECEIPTS = new Set<string>(['conversation-telepath', 'conversation-directed']);

/** The sigil each receipt's channel was addressed with — see `originalOf`. */
const SIGILS: Record<string, string> = {
  'conversation-telepath': '/',
  'conversation-directed': '>'
};

/**
 * The line as it happened, for the `original` layout.
 *
 * For everything the *server* said, that is `block.text` — its own sentence,
 * verbatim, which is the same run of words the console carries two panes away.
 * Nothing is composed and nothing is reordered, which is what makes `original`
 * the default: it is the one shape that invents nothing.
 *
 * A **receipt** is the exception, and it has to be. `--- Telepath Sent to
 * Brackle ---` is the server confirming a send without echoing it, so its own
 * sentence is framing with the message missing — showing that verbatim would
 * be the card losing the one thing it exists to keep, which is the failure
 * `Classifier.bindReceipt` was written to fix. So the line is stated as it was
 * **typed**: the channel's sigil, the recipient the *server* resolved, and the
 * body the classifier bound. Where nothing was bound — two telepaths in flight
 * at once — the server's own line stands, because a body invented for it would
 * be the client misquoting its own player.
 */
function originalOf(message: Block): string {
  const body = message.groups['sent'];
  const to = message.groups['player'];
  if (body === undefined || to === undefined) return message.text;
  const sigil = SIGILS[message.type];
  return sigil === undefined ? message.text : `${sigil}${to} ${body}`;
}

/** The channels the composer can be pointed at. See `shared/talk.ts`. */
const CHANNEL_WORDS = TALK_CHANNELS.map((entry) => entry.word);

/**
 * Who a name on a line is, filed once per roster rather than once per line.
 *
 * `isKnownPlayer` and `isSelf` read three things off the character — its own
 * name, the registry and the roster — and every status line the server prints
 * replaces the character object they sit on without changing any of the
 * three. A line memoised on the character would therefore redraw on every
 * status line, which in a fight is ten times a second for five hundred lines;
 * built once per *value* of those three instead, it holds until a `who` lands
 * or somebody logs in, and a line can be memoised on it.
 */
interface People {
  /** This character's own name: the one name on a line that is never a control. */
  self: string | null;
  /** Whether the registry or the roster knows this person — the one test of which a name is. */
  known(name: string): boolean;
}

interface TalkLineProps {
  message: Block;
  layout: TalkLayout;
  stamped: boolean;
  stampFormat: TalkStamp;
  people: People | null;
  names: NameIndex | null;
  /**
   * `names.version`, beside the index it belongs to and never read here.
   *
   * The index is one object per character whose people change *in place*, so
   * a memo comparing the index alone would hold a sentence linked against
   * last hour's roster. The number is what makes a roster change a prop
   * change; `NamedText` re-searches on it for the same reason.
   */
  namesVersion: number;
  onSelect?(name: string, anchor: PopoverAnchor): void;
  inspect?(name: string, anchor: HTMLElement): void;
}

/**
 * One line of the backlog, drawn once and left alone.
 *
 * Every prop is a value or a reference that holds for as long as the fact it
 * carries does — the block itself is never replaced, the layout is a word,
 * `people` is keyed by value, the index is per character — so a line renders
 * when it arrives and again only when the card is re-arranged or the roster
 * moves. Without this boundary a new line, a status line and a find-field
 * keystroke each rebuilt all five hundred: `linkify` over every sentence, the
 * name index over every run, React reconciling the lot.
 */
const TalkLine = memo(function TalkLine(props: TalkLineProps) {
  const { message, layout, stamped, stampFormat, people, names, onSelect, inspect } = props;
  const outbound = RECEIPTS.has(message.type) && message.groups['message'] === undefined;
  return (
    <div className="line" data-channel={message.type}>
      {/*
        The time the classifier stamped the block, never the moment
        this rendered: a backlog restored from the conversation log
        is hours old, and drawing "now" beside it would be the card
        lying about when the conversation happened.
      */}
      {stamped && <span className="stamp">{formatTalkStamp(message.at, stampFormat)}</span>}
      {layout === 'original' ? (
        /*
          The realm's own sentence, with both the links and the names
          in it as controls.

          The speaker is inside the text here rather than in a column
          of its own, so it is found the way the Alerts card finds
          one — through the console's own index. Without that, the
          default layout would be the one that quietly took the
          clickable names away.

          **Nested, not interleaved.** `linkify` splits first and
          `NamedText` searches each run it did *not* claim, which
          composes two passes that both cut the same string without
          either knowing about the other. A web address is not a
          place a player's name is looked for, so nothing is lost by
          the order; the other order would have `NamedText` cutting a
          URL in half around a word that happened to be a monster.
        */
        <span className="said">
          {linkify(originalOf(message)).map((part, at) =>
            part.href !== undefined ? (
              <a
                href={part.href}
                key={`${at}-${part.href}`}
                // `_blank` goes through main's window-open handler,
                // which refuses the app frame and any scheme but http.
                rel="noreferrer noopener"
                target="_blank"
              >
                {part.text}
              </a>
            ) : names && people && inspect && onSelect ? (
              <NamedText
                index={names}
                inspect={inspect}
                key={at}
                onSelect={onSelect}
                self={people.self}
                text={part.text}
              />
            ) : (
              part.text
            )
          )}
        </span>
      ) : (
        <>
          <span className="channel">{CHANNELS[message.type] ?? message.type}</span>
          {/* A name the registry or the roster knows is the control that
          opens their card; a name only a line carried — the recipient
          of this character's own telepath — stays text, because the
          card it would open says nothing is known. */}
          <span className="who">
            {outbound && `${t('cards.talk.sentTo')} `}
            {message.groups['player'] === undefined ? (
              t('cards.map.legendYou')
            ) : onSelect && people && people.known(message.groups['player']) ? (
              <PlayerName
                className="name"
                name={message.groups['player']}
                onSelect={onSelect}
                self={isOwnName(people.self, message.groups['player'])}
              />
            ) : (
              message.groups['player']
            )}
          </span>
          {/*
            The message verbatim; the parser already stripped the framing.
            On this character's own receipts the body is `sent` — bound by
            the classifier from the command, because the server confirms a
            telepath without echoing it.

            Split into runs of text and the web addresses between them, so a
            link somebody gossiped can be followed rather than retyped —
            and *split*, never `dangerouslySetInnerHTML`, because this text
            is written by other players on a MUD.
          */}
          <span className="said">
            {linkify(message.groups['sent'] ?? message.groups['message'] ?? message.text).map(
              (part, at) =>
                part.href === undefined ? (
                  part.text
                ) : (
                  <a
                    href={part.href}
                    key={`${at}-${part.href}`}
                    // `_blank` goes through main's window-open handler, which
                    // refuses the app frame and refuses any scheme but http.
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {part.text}
                  </a>
                )
            )}
          </span>
        </>
      )}
    </div>
  );
});

/** The channel the box is pointed at, and every channel it can be pointed at. */
interface ComposerPicker {
  channel: TalkChannel;
  options: readonly TalkChannel[];
  /** Points the composer at a channel, remembering it where it can be. */
  point(next: TalkChannel): void;
}

interface ComposerProps {
  /**
   * The picker, or `null` where the box sends what was typed and nothing else.
   *
   * Null is the shipped answer (`CardSettings.talkChannels`). One prop and not
   * a flag beside a channel, because a channel showing with no picker to change
   * it is a state nobody can get out of: the word would go in front of every
   * line with no control on screen saying so.
   */
  picker: ComposerPicker | null;
  /** Sends a line — `ConversationCardProps.onSend`. Absent offline, and the box with it. */
  send?(line: string): void;
  /** A line of several commands — `ConversationCardProps.onMacro`. */
  macro?(line: string): void;
  /** Commands still waiting from this box, and the press that drops them. */
  queued: number;
  drop?(): void;
}

/**
 * The reply box and its picker, owning what is being typed.
 *
 * The draft is this component's state and nobody else's, and that is the
 * whole reason it is a component. It was state on the card, so every keystroke
 * re-rendered the card — five hundred lines of backlog, each run through
 * `linkify` and the name index and reconciled again — before the typed
 * character could be painted, and a player watched their own words crawl into
 * the box. A key pressed here now redraws a form of two controls; the figures
 * are in `mudengine-ui` under *the window redraws what changed*.
 */
function Composer({ picker, send, macro, queued, drop }: ComposerProps) {
  const [draft, setDraft] = useState('');
  /*
   * What has been said from this box, newest first, and where the arrows are
   * in it — `-1` being the live draft rather than an entry.
   *
   * Kept beside the draft and for the draft's reason: the composer owns what is
   * being typed, and a character that drops keeps both. Lines are stored **as
   * typed**, before `compose` puts a channel word in front of them, because
   * what Up is for is saying the same thing again — and the same thing again on
   * whichever channel is pointed at now, which is what the player would get by
   * retyping it.
   */
  const [history, setHistory] = useState<string[]>([]);
  const [at, setAt] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  // Below the hooks and before the form, so a character that drops keeps the
  // half-typed line for when it is back — which is what the card did while the
  // draft was its own state, and what a mounted-then-unmounted box would lose.
  if (!send) return null;

  const say = (): void => {
    if (picker === null) {
      /*
       * The line as it was typed, spacing and all — main trims before it
       * interprets anything (`SessionManager.send`), so nothing here has to.
       *
       * An empty box is the one thing not sent, and deliberately: main reads a
       * bare Return as a reread of the room, and Down past the newest line is
       * how a recall is abandoned. Those two together would make *put the box
       * back* into *nudge the server*.
       */
      if (draft.trim().length === 0) return;
      /*
       * Several commands in one line (todo 04): `;` between them, `2d,6s` for
       * repeats. Handed to main whole, which parses it again and sends one a
       * prompt. Only this box: a channel's message may carry a semicolon.
       */
      if (macro !== undefined && parseMacro(draft) !== null) macro(draft);
      else send(draft);
    } else {
      /*
       * Verbatim still, and with a channel in front of it when one is needed.
       *
       * The realm's own vocabulary is the vocabulary — `gos`, `auc`, `br`,
       * `gb` — and a client that rewrote it would be a second thing to keep in
       * step with a command table it does not own. What `compose` adds is the
       * *prefix*, and only when the line does not already begin with a channel:
       * type `br yo` and it broadcasts and moves the picker, so the next line
       * goes there too without being told again. See `shared/talk.ts`.
       */
      const said = compose(draft, picker.channel);
      if (said === null) return;
      if (said.channel.word !== picker.channel.word) picker.point(said.channel);
      /*
       * An address with nothing after it — `/Soul` — moves the picker and sends
       * nothing. It names somebody to talk to and says nothing to them, and the
       * server's answer to that is a scolding that costs a command.
       */
      if (said.command !== null) send(said.command);
    }
    /*
     * The line joins the history unless it is already at the front of it. A
     * line said twice running is one entry, as it is in a shell: arrowing back
     * through five identical `y`s is the history being in the way of itself.
     */
    setHistory((was) =>
      was[0] === draft ? was : [draft, ...was].slice(0, tuning().talkHistoryLimit)
    );
    setAt(-1);
    setDraft('');
  };

  /**
   * Up and Down through what has been said.
   *
   * A single-line input has nowhere vertical to put the caret, so both keys are
   * free — and both are what a person coming from any other console expects to
   * work. Up walks back and stops at the oldest line rather than wrapping;
   * Down walks forward and, past the newest, empties the box, which is the
   * "until clear" half and the way back out of the history without sending
   * anything.
   *
   * The caret is put at the end of the recalled line in the same frame, because
   * a line recalled to be edited is nearly always edited at its end.
   */
  const recall = (step: 1 | -1): void => {
    const next = Math.min(Math.max(at + step, -1), history.length - 1);
    if (next === at) return;
    setAt(next);
    setDraft(next < 0 ? '' : (history[next] ?? ''));
    requestAnimationFrame(() => {
      const box = inputRef.current;
      if (box) box.setSelectionRange(box.value.length, box.value.length);
    });
  };

  return (
    <form
      className="conversation-say"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        say();
      }}
    >
      {picker !== null && (
        <>
          {/*
            The picker, drawn only where there is one: a control over a decision
            nothing is making would be the card describing something it does not
            do.

            It is a `select` rather than a row of pills: this is one choice out
            of six sitting on the same line as the box it qualifies, which is
            what a select is, and a row of six pills here would take the width
            the message needs.

            **No `keepFocus` on the mousedown, and that is the whole reason this
            could not be opened.** A native select raises its popup on
            *mousedown*, so preventing that default suppressed the popup and
            left a control that could be read and never changed — a dropdown
            that does not drop down. The rule it was borrowed from is for
            controls that are clicked and never typed into, and a select is
            operated with the keyboard too. So it takes the caret, says so with
            `data-owns-keys` while it holds it so a bare hotkey stands down, and
            hands it to the message box on the way out, which is where the next
            keystroke was always going.

            The rows say the *label*, not the command word. Four of the six read
            perfectly well as words, and two of them are `.` and `"` — a row
            that says `"` says nothing. It also stops the card speaking two
            vocabularies: the filters above already name the same channels in
            the same words.
          */}
          <select
            aria-label={t('cards.alerts.columns.channel')}
            data-owns-keys="true"
            onChange={(event) => {
              const chosen = picker.options.find((entry) => entry.word === event.target.value);
              if (chosen) picker.point(chosen);
              inputRef.current?.focus();
            }}
            onKeyDown={(event) => {
              /*
               * Escape hands the keyboard back, exactly as it does from the
               * message box beside it. Opening the picker and changing nothing
               * would otherwise leave the caret parked on chrome, and a held
               * caret is a swallowed keystroke. A native popup takes its own
               * Escape first, so this is the one that arrives after it closes.
               */
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.currentTarget.blur();
            }}
            value={picker.channel.word}
          >
            {picker.options.map((entry) => (
              <option key={entry.word} value={entry.word}>
                {entry.label}
              </option>
            ))}
          </select>
        </>
      )}
      <input
        aria-label={t('cards.talk.messageInputAria')}
        onChange={(event) => {
          setDraft(event.target.value);
          // Typing leaves the history: what is in the box is the player's own
          // line again, and Down should empty it rather than walk back to it.
          setAt(-1);
        }}
        onKeyDown={(event) => {
          /*
           * Up and Down are the history, and they are claimed here rather than
           * left to the browser: an input answers them by parking the caret at
           * one end, which is a gesture nobody makes on a box one line tall.
           */
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            recall(event.key === 'ArrowUp' ? 1 : -1);
            return;
          }
          /*
           * Enter is handled here rather than left to the form's implicit
           * submission — the same reason the route panel handles its own:
           * implicit submission is a browser default that is easy to lose,
           * and CDP does not drive it, so the smoke test cannot prove the
           * thing a player actually does.
           */
          if (event.key === 'Enter') {
            event.preventDefault();
            say();
            return;
          }
          /*
           * Escape hands the keyboard back to the game.
           *
           * This is the one surface in the HUD that holds the caret while
           * you are playing, and a held caret is a swallowed keystroke —
           * which can cost a character. Enter deliberately does *not* hand
           * it back: this is a composer, and a conversation is more than
           * one line. Escape is the way out, and it is the key that leaves
           * every other surface too.
           */
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setDraft('');
          setAt(-1);
          inputRef.current?.blur();
        }}
        /*
         * What the box does, in the box, and the two boxes do two things.
         *
         * With no channel it says what is typed is what is sent. With one
         * showing to the left, the part nobody would guess is that a line
         * starting with one of the realm's own openers goes *there* instead —
         * and listing every opener `compose` acts on beats naming two of them,
         * because `/` and `>` address one person and the picker cannot offer
         * either until somebody has been named, and a player who can see `.`
         * and `"` does not have to discover that say and yell are punctuation
         * here. Glyphs first, then words, so the run reads as one vocabulary.
         *
         * Two literal `t()` calls and not one conditional key: the coverage
         * test reads the literal after `t(`.
         */
        placeholder={
          picker === null
            ? t('cards.talk.messagePlaceholderAsTyped')
            : t('cards.talk.messagePlaceholder')
        }
        ref={inputRef}
        spellCheck={false}
        value={draft}
      />
      {/*
        What is still waiting of a line of several commands, and the one way to
        take it back: a path gone wrong at its third step would otherwise walk
        the other twelve. A press drops them; the caret stays where it was.
      */}
      {queued > 0 && drop !== undefined && (
        <button
          className="conversation-queued"
          onClick={drop}
          onMouseDown={keepFocus}
          title={t('cards.talk.dropQueuedHint')}
          type="button"
        >
          {queued === 1
            ? t('cards.talk.queued.one', { count: queued })
            : t('cards.talk.queued.many', { count: queued })}
        </button>
      )}
    </form>
  );
}

/**
 * What everyone is saying.
 *
 * This is a social game, and the channels are most of it: a player who misses a
 * telepath has missed the thing they were waiting for. The terminal already
 * carries every line, but it carries *everything* — a conversation scrolls out
 * of reach behind a combat burst within seconds, which is exactly when someone
 * is least able to go looking for it.
 *
 * So this is a second view of the same stream, filtered to the channels and
 * kept. Nothing is re-requested from the server and nothing is sent: it reads
 * the block feed every other consumer reads.
 *
 * Filtering is per channel and remembered, because which channels matter is a
 * matter of taste and of what someone is doing — a trader wants auction, a
 * gang wants gangpath, and neither wants the other's noise.
 */
function ConversationCard({
  messages,
  onSend,
  onMacro,
  macroQueued = 0,
  onDropMacro,
  onSelect,
  character,
  names,
  inspect,
  session,
  ...chrome
}: ConversationCardProps) {
  /*
   * Which channels are showing, remembered per character like the rail's
   * arrangement: the channels somebody watches are a standing choice.
   *
   * Two remembered things, because the master and the row underneath it are
   * two decisions. `talk-all` is one of two words and ships **on**, which is
   * what the card has always opened as; `talk-muted` is the set the reader
   * turned *off*, so nothing stored means nothing muted and a channel added to
   * the parser later arrives visible rather than silently absent. A stored id
   * the build no longer knows is dropped by the hook.
   */
  const [allWord, chooseAll] = useRememberedChoice(session, 'talk-all', ALL_WORDS, 'on');
  const all = allWord === 'on';
  const muted = useRemembered(session, 'talk-muted', CHANNEL_IDS);
  /*
   * How this card draws a line, from the gear in its own action column. Read
   * off `chrome.settings` rather than taken as a prop of its own: that object
   * is already this card's settings for *this* character, addressed the way a
   * pinned float's are, so a second route to the same four values would be a
   * second thing to address correctly.
   *
   * The time is drawn unless somebody said not to. It is *recorded* either
   * way — `Block.at` is stamped by the classifier and `TalkLog` writes the
   * whole block — so this decides what the card shows and never what is kept.
   *
   * The channel is the one that ships **off**; `mudengine-ui` has why, under
   * *the Talk card sends verbatim*.
   */
  const settings = chrome.settings?.value;
  const stamped = settings?.talkStamps ?? true;
  const stampFormat = settings?.talkStamp ?? DEFAULT_TALK_STAMP;
  const layout: TalkLayout = settings?.talkLayout ?? DEFAULT_TALK_LAYOUT;
  const channels = settings?.talkChannels ?? false;
  /*
   * Which channel the composer is pointed at, remembered like the filters and
   * for the same reason: having to choose it again on every launch is the
   * client asking after being told. Gossip is the default because it is the one
   * everybody is in. Kept whether or not the picker is drawn, so turning it
   * back on finds the channel this character was last talking on.
   */
  const [channelWord, chooseChannel] = useRememberedChoice(
    session,
    'talk-channel',
    CHANNEL_WORDS,
    TALK_CHANNELS[0]!.word
  );
  /*
   * Telepath and direct are not in the remembered list, because they address
   * somebody: `/Soul` is a channel only while Soul is who this character is
   * talking to. Held for as long as the card is on this character and dropped
   * when it changes, rather than stored — a client that resumed telepathing a
   * name from a fortnight ago would be talking into the dark.
   */
  const [addressed, setAddressed] = useState<TalkChannel | null>(null);
  useEffect(() => {
    setAddressed(null);
  }, [session]);
  const channel = addressed ?? talkChannel(channelWord);
  const options = addressed === null ? TALK_CHANNELS : [...TALK_CHANNELS, addressed];

  /** Points the composer at a channel, remembering it where it can be. */
  const point = (next: TalkChannel): void => {
    if (next.kind === 'addressed') {
      setAddressed(next);
      return;
    }
    setAddressed(null);
    chooseChannel(next.word);
  };

  /*
   * What is being looked for in the backlog.
   *
   * The Talk card is deliberately **not** a table: a line somebody said is
   * prose that wraps, and cutting it into a column narrow enough to line up
   * with the others is the one thing that would make it unreadable. What it
   * takes from the tables is the find field alone — because "what did he say
   * the password was" is asked of this card more than of any other, and the
   * answer is four hundred lines up behind a combat burst.
   *
   * Held here rather than remembered: a channel someone muted is a standing
   * choice about what they care about, and a search is a question they are
   * asking right now. A card that opened tomorrow still filtered to `key` would
   * be hiding the conversation it exists to show.
   */
  const [query, setQuery] = useState('');
  /*
   * Whether the find row is out at all. It used to stand open above the
   * feed on every card, spending a row on a question nobody was asking;
   * it is behind the search glyph in the action column now, and closes —
   * clearing itself — on the Escape that ends the question. Not
   * remembered, for the reason the query is not: a search is asked now.
   */
  const [finding, setFinding] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  /*
   * Where the box was the last time the card knew — where it put it, or where
   * a `scroll` event found it — and the hold: the timer that puts the log back
   * to following after the reader has stopped scrolling. Following is simply
   * *no hold*, and only the reader's own scroll takes one.
   *
   * Refs rather than state, for the reason `tuning()` is not state either:
   * nothing on screen is drawn from either of them. Where the box is scrolled
   * to is a fact the box already holds, and making a copy of it state would
   * redraw every line in the backlog on a wheel turn.
   */
  const seenTopRef = useRef(0);
  const resumeRef = useRef<number | undefined>(undefined);
  /** The frame awaited when the box moved and its `scroll` event has not landed. */
  const settleRef = useRef(0);
  /**
   * Where this card itself last put the box.
   *
   * **A scroll the card caused is not the reader scrolling** (todo 10). The
   * `scroll` event says nothing about who moved the box, and following the
   * newest line *is* a scroll — delivered a frame later, by which time another
   * line may have arrived and made the position the card set no longer the
   * live edge. Read as a backscroll, every arriving line then extended a hold
   * nobody had asked for, and a busy conversation never followed at all.
   *
   * So every programmatic move records where it put the box, and a `scroll`
   * landing there is this card's own. A person's scroll lands somewhere else
   * by definition: the wheel, the bar and the keys all move it.
   */
  const ownScrollRef = useRef(-1);
  /**
   * Whether lines have arrived while the reader is holding the box still.
   *
   * The one thing here that is state: it draws the *jump to latest* button, as
   * the console's own hold draws one. False while following, so the button is
   * absent rather than disabled — there is nothing to jump to.
   */
  const [behind, setBehind] = useState(false);

  /*
   * The faces with anything behind them, in their fixed order. The whole
   * stream is always offered; a channel earns its pill by having spoken.
   */
  const faces = useMemo(
    () =>
      FACES.filter(
        (face) =>
          face.types === null || messages.some((message) => face.types!.includes(message.type))
      ),
    [messages]
  );

  /*
   * The block types on screen: every one while `All` is on, otherwise the
   * union of the channels that are not muted.
   *
   * Null is *everything*, which is what `All` means and also what an empty
   * mute set under it comes to — kept as null rather than the union so a
   * channel the parser gains and this list has not caught up with is still
   * drawn while All is on.
   */
  const showing = useMemo(() => {
    if (all) return null;
    const types = new Set<string>();
    for (const entry of FACES) {
      if (entry.types === null || muted.has(entry.id)) continue;
      for (const type of entry.types) types.add(type);
    }
    return types;
  }, [all, muted]);

  const shown = useMemo(
    () =>
      messages.filter(
        (message) =>
          (showing === null || showing.has(message.type)) &&
          matches(query, [
            CHANNELS[message.type] ?? message.type,
            message.groups['player'] ?? t('cards.map.legendYou'),
            message.groups['sent'] ?? message.groups['message'] ?? message.text
          ])
      ),
    [messages, showing, query]
  );

  /*
   * Who is a person, keyed by value — see `People`. The key is every fact
   * `isKnownPlayer` and `isOwnName` read, so the closure below is stale only
   * in ways those two cannot observe; the `phasesKey` in `App.tsx` is the
   * same shape for the same reason.
   */
  const peopleKey =
    character === undefined
      ? null
      : [
          character.name ?? '',
          ...Object.keys(character.players),
          ...character.online.map((entry) => entry.name)
        ].join('\n');
  const people = useMemo<People | null>(
    () =>
      character === undefined
        ? null
        : { self: character.name, known: (name) => isKnownPlayer(character, name) },
    // The character is deliberately not a dependency: it is a new object on
    // every status line, and the key already says when what is read off it moved.
    [peopleKey]
  );

  /**
   * One pixel of slack, because all three figures are fractional: a box at the
   * live edge on a display whose device pixel ratio is not a whole number
   * lands a rounding error short of it, and an exact comparison would read
   * that as the reader having scrolled up.
   */
  const atEdge = (node: HTMLDivElement): boolean =>
    node.scrollHeight - node.scrollTop - node.clientHeight <= 1;

  /** Puts the box on the newest line, recording that the card put it there. */
  const pin = (node: HTMLDivElement): void => {
    node.scrollTop = node.scrollHeight;
    // What the card put there, so the `scroll` event this causes is known for
    // the card's own and does not read as somebody scrolling away.
    ownScrollRef.current = node.scrollTop;
    seenTopRef.current = node.scrollTop;
  };

  /** Puts the log on the newest line, and lets go of any hold on it. */
  const follow = (): void => {
    window.clearTimeout(resumeRef.current);
    resumeRef.current = undefined;
    setBehind(false);
    const node = logRef.current;
    if (node !== null) pin(node);
  };

  /*
   * The hold, and when it expires.
   *
   * The one place a hold is taken: a scroll the card did not cause, landing
   * anywhere but the live edge. The wait runs from the *last* scroll — reading
   * further up extends it — and arriving back at the live edge lets go at once
   * rather than after it.
   */
  const noteScroll = (): void => {
    const node = logRef.current;
    if (node === null) return;
    seenTopRef.current = node.scrollTop;
    // The card's own move, arriving a frame late. Not a backscroll, whatever
    // the geometry says by now — see `ownScrollRef`.
    if (Math.abs(node.scrollTop - ownScrollRef.current) <= 1) return;
    ownScrollRef.current = -1;
    window.clearTimeout(resumeRef.current);
    if (atEdge(node)) {
      resumeRef.current = undefined;
      setBehind(false);
      return;
    }
    resumeRef.current = window.setTimeout(follow, tuning().talkFollowResumeMs);
  };

  /*
   * Pinned to the newest, like the terminal it mirrors — unless the reader has
   * scrolled up, which is the one thing that outranks new output. Nothing the
   * server prints may undo what the player did.
   *
   * **Following is the state, and only `noteScroll` leaves it**: the box's
   * size is not the reader (`mudengine-ui`, *The feed follows the newest
   * line*). Geometry answers one question — has the box moved since the card
   * last saw it, with its `scroll` event still in flight? A wheel is scrolled
   * on the compositor and its event lands a frame later; that event decides,
   * so no commit pins under it. Two frames on it has landed or never will.
   *
   * A layout effect, so the box is never painted holding new lines at the old
   * offset. The *log* scrolls, not the card: the filters belong at the top and
   * the composer at the bottom, and both scrolling away is how a chat window
   * becomes one you have to scroll back to in order to reply.
   *
   * Keyed on `shown` itself and not on its length, which stopped changing at
   * `talkLimit`: once the backlog is full every new line drops an old one, so
   * the count sits at 500 and a card left open through a long conversation
   * quietly stopped following.
   */
  useLayoutEffect(() => {
    const node = logRef.current;
    if (node === null) return;
    if (resumeRef.current !== undefined) {
      // Held, and a line has arrived behind the reader's back: that is exactly
      // what the button is for. Set here rather than derived from the message
      // count, because *behind* is about this reader's box and not about how
      // many lines the card holds.
      setBehind(true);
      return;
    }
    if (Math.abs(node.scrollTop - seenTopRef.current) > 1) {
      if (settleRef.current === 0) {
        settleRef.current = requestAnimationFrame(() => {
          settleRef.current = requestAnimationFrame(() => {
            settleRef.current = 0;
            const moved = Math.abs(node.scrollTop - seenTopRef.current) > 1;
            if (moved && resumeRef.current === undefined) pin(node);
          });
        });
      }
      return;
    }
    pin(node);
  }, [shown]);

  /*
   * And a box that changes size while following stays on the newest line at
   * once, rather than at the next line said: shorter hides the newest lines
   * under the composer. Zero is a rolled card, which has no edge to keep, and
   * unrolling it is a new view of the backlog, like another face.
   */
  useEffect(() => {
    const node = logRef.current;
    if (node === null) return;
    let hidden = node.clientHeight === 0;
    const observer = new ResizeObserver(() => {
      const wasHidden = hidden;
      hidden = node.clientHeight === 0;
      if (hidden) return;
      if (wasHidden) follow();
      else if (resumeRef.current === undefined) pin(node);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /*
   * A different view of the backlog starts at the newest line, hold or no
   * hold: the place somebody was holding was a place in the conversation they
   * were reading, and a narrowed set of channels, a search or another
   * character is not it. The find row counts because it is a row — opening it
   * makes the box shorter, and a reader at the live edge would otherwise be
   * left a line above it with nothing to tell them so.
   *
   * Keyed on the set of channels drawn rather than on the toggles, so muting a
   * channel that has said nothing does not move the reader. Declared after the
   * effect above and a layout effect like it, so on a change it is this one
   * that lands, in the same frame.
   */
  const showingKey = showing === null ? '*' : [...showing].sort().join(',');
  useLayoutEffect(() => {
    follow();
  }, [showingKey, query, finding, session]);

  /* The hold and the settle are this card's own, so they go when the card does. */
  useEffect(
    () => () => {
      window.clearTimeout(resumeRef.current);
      cancelAnimationFrame(settleRef.current);
    },
    []
  );

  const feed = (
    <>
      {finding && (
        <FindField
          autoFocus
          label={t('cards.talk.find')}
          onChange={setQuery}
          onDismiss={() => setFinding(false)}
          query={query}
          returnFocus={chrome.returnFocus}
        />
      )}

      {/*
        `data-layout` and `data-stamped` are what the alignment is done with:
        in `condensed-aligned` the log becomes one grid and each line a
        `subgrid` row, so the columns are sized by the browser from the widest
        content — no padding to a character count, and no pixel constant, which
        this card could not hold anyway (it is resizable, floatable, and the
        chrome font is whatever the options file says). The stamp is a column
        of its own when it is on, which is why the template needs to know.
      */}
      <div
        className="conversation-log scroller"
        data-layout={layout}
        data-stamped={stamped ? 'true' : undefined}
        onScroll={noteScroll}
        ref={logRef}
      >
        {shown.length === 0 ? (
          <div className="empty">
            {query.length > 0 ? t('cards.talk.empty.noMatch') : t('cards.talk.empty.none')}
          </div>
        ) : (
          shown.map((message) => (
            <TalkLine
              inspect={inspect}
              key={`${message.seq}-${message.at}`}
              layout={layout}
              message={message}
              names={names ?? null}
              namesVersion={names?.version ?? 0}
              onSelect={onSelect}
              people={people}
              stamped={stamped}
              stampFormat={stampFormat}
            />
          ))
        )}
      </div>
      {/*
        Something was said while the reader was holding the box still (todo
        10). The console's own affordance, in the console's own register: the
        one way back to the live edge that does not require finding the bottom
        of a scrollbar. Absent rather than disabled while following — there is
        nothing to jump to — and it lets go of the hold, which is what a press
        on it means.
      */}
      {behind && (
        <button
          className="jump-latest talk-jump"
          onClick={follow}
          // The caret stays where it was — in the composer, or in the terminal.
          // A control clicked and never typed into does not take focus, and
          // this one would otherwise swallow the next thing typed.
          onMouseDown={keepFocus}
          type="button"
        >
          {t('cards.talk.jumpToLatest')}
        </button>
      )}
    </>
  );

  /*
   * Every face draws the same node: only the active face is rendered, and
   * `feed` is already built from it. The composer rides inside the face so
   * the reply box keeps its place at the foot of the paned body.
   */
  const content = (
    <>
      {feed}
      <Composer
        drop={onDropMacro}
        macro={onMacro}
        picker={channels ? { channel, options, point } : null}
        queued={macroQueued}
        send={onSend}
      />
    </>
  );
  /*
   * The heading's controls. `All` first and always live; every other one is
   * drawn in its own state and refuses the press while `All` is on, so
   * turning the master off puts the reader's own choices back rather than
   * starting them again from nothing.
   */
  const filters: CardFilter[] = faces.map((entry) =>
    entry.types === null
      ? {
          id: entry.id,
          label: entry.label,
          on: all,
          toggle: () => chooseAll(all ? 'off' : 'on')
        }
      : {
          id: entry.id,
          label: entry.label,
          on: !muted.has(entry.id),
          disabled: all,
          toggle: () => muted.toggle(entry.id)
        }
  );

  return (
    <BentoCard
      badge={<span className="chip off">{shown.length}</span>}
      className="conversation-card"
      filters={filters}
      {...chrome}
      actions={[
        {
          id: 'find',
          label: t('cards.talk.find'),
          icon: 'search',
          run: () => {
            if (finding) {
              setQuery('');
              setFinding(false);
              chrome.returnFocus?.();
              return;
            }
            setFinding(true);
          }
        }
      ]}
      paned
      title={t('cards.talk.title')}
    >
      {content}
    </BentoCard>
  );
}

export default memo(ConversationCard);
