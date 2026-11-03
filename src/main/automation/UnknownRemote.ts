/**
 * An `@` word this client has no entry for (`@auto-attack on`), answered
 * `{command invalid or not allowed}` as MegaMUD 2.1 answers one
 * (`captures/215`, `@seen`; the user, 2026-11-03, todo 20261102-2217-02).
 * Only on a telepath or a say to this character, from somebody it talks to,
 * and never for a word that names a player: anything else is talk. See
 * `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import type { BlockType } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import type { PlayerRecord } from '../../shared/players';
import { parseUnknownCall, reachableBy, REFUSED_REPLY } from '../../shared/remotes';
import { evidenceAbout } from './RemoteEvidence';

/**
 * The channels addressed to this character alone. A room say, the gangpath
 * and the realm-wide channels reach others too, where `@quirk you hung`
 * (Deacon's gossip, Rayzor's session log, 2026-10-29 01:34) is a player
 * talking to a player.
 */
const ADDRESSED: ReadonlySet<BlockType> = new Set<BlockType>([
  'conversation-telepath',
  'conversation-directed'
]);

/** What a word with no entry needs from `Remotes`. */
export interface UnknownRemoteDeps {
  config(): AutomationConfig;
  reply(to: string, body: string, prefix: string, decision: DecisionKind): void;
  notice?: NoticeSink;
  commanded?(from: string, raw: string, at: number): void;
  peer?(who: string): PlayerRecord | null;
}

/** One message `parseRemoteCall` did not read, as it arrived. */
export interface UnheardMessage {
  from: string;
  message: string;
  channelType: BlockType;
  /** What an answer is spoken with, or null on a channel this client never answers on. */
  prefix: string | null;
  at: number;
}

const DECISION: DecisionKind = 'remote-answer';

/** Answers `heard` when it is an unknown word from somebody this character talks to. */
export function answerUnknown(
  heard: UnheardMessage,
  state: CharacterState,
  deps: UnknownRemoteDeps
): void {
  const { from, message, channelType, prefix, at } = heard;
  if (prefix === null || !ADDRESSED.has(channelType)) return;
  const call = parseUnknownCall(message);
  if (call === null || namesAPlayer(call.word, state.name, deps.peer)) return;
  const config = deps.config();
  if (!reachableBy(from, config.remotes, evidenceAbout(from, state))) return;
  deps.commanded?.(from, call.word, at);
  // The master switch holds the reply and never the reading, as for every remote.
  if (config.enabled) deps.reply(from, REFUSED_REPLY, prefix, DECISION);
  deps.notice?.(t('automation.remotes.refusedUnknown', { from, raw: call.word }), DECISION);
}

/**
 * Whether an unknown word is a player's name, which makes `@quirk you hung`
 * talk on either side: answered by nobody here, and kept by nobody when typed.
 */
export function namesAPlayer(
  word: string,
  self: string | null,
  peer: UnknownRemoteDeps['peer']
): boolean {
  if (self !== null && self.toLowerCase() === word) return true;
  return (peer?.(word) ?? null) !== null;
}
