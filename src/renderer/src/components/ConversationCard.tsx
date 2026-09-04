import { memo, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import { FindField } from './CardTable';
import { t } from '../lib/i18n';
import NamedText from './NamedText';
import type { NameIndex } from '../lib/names';
import { isKnownPlayer, isSelf, PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import { matches } from '../lib/table';
import { linkify } from '../lib/linkify';
import { useRememberedChoice } from '../hooks/useRemembered';
import {
  compose,
  DEFAULT_TALK_LAYOUT,
  DEFAULT_TALK_STAMP,
  formatTalkStamp,
  talkChannel,
  TALK_CHANNELS,
  type TalkChannel,
  type TalkLayout
} from '@shared/talk';
import type { SessionId } from '@shared/ipc';
import type { CharacterState } from '@shared/character';
import type { Block } from '@shared/blocks';

export interface ConversationCardProps extends CardChrome {
  /** Conversation blocks for this character, oldest first. */
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
  /*
   * Both directions land here: `Soul says (to you) "..."` arriving, and the
   * `--- Message Directed to Soul ---` receipt for one sent from this card.
   * "to you" was true of only the first of the two.
   */
  'conversation-directed': t('cards.talk.channels.direct')
};

/**
 * The card's faces: everything, then one per channel, in the heading where
 * the mute chips used to spend a row of the body. `types: null` is the whole
 * stream; `local` folds the three channels that are the same conversation —
 * what is said in the room reaches the same ears whether it was said, yelled
 * or directed. A face appears only while its channel has said something,
 * the same rule the chips followed: a control over nothing is chrome.
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
    types: ['conversation-yell', 'conversation-local', 'conversation-directed']
  }
];

const FACE_IDS = FACES.map((face) => face.id);

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
  onSelect,
  character,
  names,
  inspect,
  session,
  ...chrome
}: ConversationCardProps) {
  /*
   * Which face is showing, remembered per character like the rail's
   * arrangement: the channel somebody watches is a standing choice. A
   * remembered face whose channel has gone quiet falls back to the whole
   * stream rather than an empty card.
   */
  const [faceId, chooseFace] = useRememberedChoice(session, 'talk-tab', FACE_IDS, FACE_IDS[0]!);
  /*
   * How this card draws a line, from the gear in its own action column. Read
   * off `chrome.settings` rather than taken as a prop of its own: that object
   * is already this card's settings for *this* character, addressed the way a
   * pinned float's are, so a second route to the same three values would be a
   * second thing to address correctly.
   *
   * The time is drawn unless somebody said not to. It is *recorded* either
   * way — `Block.at` is stamped by the classifier and `TalkLog` writes the
   * whole block — so this decides what the card shows and never what is kept.
   */
  const settings = chrome.settings?.value;
  const stamped = settings?.talkStamps ?? true;
  const stampFormat = settings?.talkStamp ?? DEFAULT_TALK_STAMP;
  const layout: TalkLayout = settings?.talkLayout ?? DEFAULT_TALK_LAYOUT;
  /*
   * Which channel the composer is pointed at, remembered like the filters and
   * for the same reason: having to choose it again on every launch is the
   * client asking after being told. Gossip is the default because it is the one
   * everybody is in.
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
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
  const face = faces.find((entry) => entry.id === faceId) ?? faces[0]!;

  const shown = useMemo(
    () =>
      messages.filter(
        (message) =>
          (face.types === null || face.types.includes(message.type)) &&
          matches(query, [
            CHANNELS[message.type] ?? message.type,
            message.groups['player'] ?? t('cards.map.legendYou'),
            message.groups['sent'] ?? message.groups['message'] ?? message.text
          ])
      ),
    [messages, face, query]
  );

  /*
   * Pinned to the newest, like the terminal it mirrors.
   *
   * The *log* scrolls, not the card: the filters belong at the top and the
   * composer at the bottom, and both scrolling away is how a chat window
   * becomes one you have to scroll back to in order to reply.
   */
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [shown.length]);

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
        ref={logRef}
      >
        {shown.length === 0 ? (
          <div className="empty">
            {query.length > 0 ? t('cards.talk.empty.noMatch') : t('cards.talk.empty.none')}
          </div>
        ) : (
          shown.map((message) => {
            const outbound = RECEIPTS.has(message.type) && message.groups['message'] === undefined;
            return (
              <div
                className="line"
                data-channel={message.type}
                key={`${message.seq}-${message.at}`}
              >
                {/*
                  The time the classifier stamped the block, never the moment
                  this rendered: a backlog restored from the conversation log
                  is hours old, and drawing "now" beside it would be the card
                  lying about when the conversation happened.
                */}
                {stamped && (
                  <span className="stamp">{formatTalkStamp(message.at, stampFormat)}</span>
                )}
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
                      ) : names && character && inspect && onSelect ? (
                        <NamedText
                          character={character}
                          index={names}
                          inspect={inspect}
                          key={at}
                          onSelect={onSelect}
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
                      ) : onSelect &&
                        character &&
                        isKnownPlayer(character, message.groups['player']) ? (
                        <PlayerName
                          className="name"
                          name={message.groups['player']}
                          onSelect={onSelect}
                          self={isSelf(character, message.groups['player'])}
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
                      {linkify(
                        message.groups['sent'] ?? message.groups['message'] ?? message.text
                      ).map((part, at) =>
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
          })
        )}
      </div>
    </>
  );

  const say = (): void => {
    if (!onSend) return;
    /*
     * Still verbatim, and now with a channel in front of it when one is needed.
     *
     * The realm's own vocabulary is the vocabulary — `gos`, `auc`, `br`, `gb` —
     * and a client that rewrote it would be a second thing to keep in step with
     * a command table it does not own. What `compose` adds is the *prefix*, and
     * only when the line does not already begin with a channel: type `br yo`
     * and it broadcasts and moves the picker, so the next line goes there too
     * without being told again. See `shared/talk.ts`.
     */
    const said = compose(draft, channel);
    if (said === null) return;
    if (said.channel.word !== channel.word) point(said.channel);
    /*
     * An address with nothing after it — `/Soul` — moves the picker and sends
     * nothing. It names somebody to talk to and says nothing to them, and the
     * server's answer to that is a scolding that costs a command.
     */
    if (said.command !== null) onSend(said.command);
    setDraft('');
  };

  const composer = onSend && (
    <form
      className="conversation-say"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        say();
      }}
    >
      {/*
            The picker, and it is a `select` rather than a row of pills: this is
            one choice out of six sitting on the same line as the box it
            qualifies, which is what a select is, and a row of six pills here
            would take the width the message needs.

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
          const chosen = options.find((entry) => entry.word === event.target.value);
          if (chosen) point(chosen);
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
        value={channel.word}
      >
        {options.map((entry) => (
          <option key={entry.word} value={entry.word}>
            {entry.label}
          </option>
        ))}
      </select>
      <input
        aria-label={t('cards.talk.messageInputAria')}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
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
          inputRef.current?.blur();
        }}
        /*
         * What the box does, in the box. The channel is already showing to
         * the left, so the placeholder's job is the part nobody would
         * guess: that a line starting with one of the realm's own openers
         * goes there instead. Listing every opener `compose` acts on beats
         * naming two of them — `/` and `>` address one person and the
         * picker cannot offer either until somebody has been named, and a
         * player who can see `.` and `"` does not have to discover that
         * say and yell are punctuation here. Glyphs first, then words, so
         * the run reads as one vocabulary rather than a sentence.
         */
        placeholder={t('cards.talk.messagePlaceholder')}
        ref={inputRef}
        spellCheck={false}
        value={draft}
      />
    </form>
  );

  /*
   * Every face draws the same node: only the active face is rendered, and
   * `feed` is already built from it. The composer rides inside the face so
   * the reply box keeps its place at the foot of the paned body.
   */
  const content = (
    <>
      {feed}
      {composer}
    </>
  );
  const tabs: CardTab[] = faces.map((entry) => ({
    id: entry.id,
    label: entry.label,
    content
  }));

  return (
    <BentoCard
      active={face.id}
      badge={<span className="chip off">{shown.length}</span>}
      className="conversation-card"
      onActive={chooseFace}
      tabs={tabs}
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
