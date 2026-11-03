import { describe, expect, it } from 'vitest';

import { newEd25519Pair } from '../../../node/ed25519';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { NO_PEER_GRANT, type PeerGrant } from '../../../shared/peerGrant';
import type { ShareLink } from '../../../shared/peers';
import type { Claimant } from '../PeerLink';
import { Sharing } from '../Sharing';

const REALM = 'orohost:2427';
const pair = newEd25519Pair();

/** Sharing over a link that keeps what it was asked to claim. */
function sharing(enabled: boolean, grants: Record<string, PeerGrant>) {
  const wanted: Claimant[][] = [];
  let made = 0;
  const waiting: Array<() => void> = [];
  const subject = new Sharing({
    enabled: () => enabled,
    sessions: () => [{ id: 'brakkle', realm: REALM, grants }],
    pairFor: () => {
      made += 1;
      return Promise.resolve(pair);
    },
    link: {
      want: (claimants) => {
        wanted.push([...claimants]);
        for (const wake of waiting.splice(0)) wake();
      },
      observe: () => undefined,
      get link(): ShareLink {
        return 'off';
      }
    },
    book: { sheetsFor: () => [], offersFor: () => [] },
    reports: { reportsFor: () => [] },
    publish: () => undefined,
    fault: () => undefined
  });
  const claimed = async (): Promise<Claimant[]> => {
    await new Promise<void>((wake) => waiting.push(wake));
    return wanted[wanted.length - 1]!;
  };
  return { subject, claimed, made: () => made };
}

const inGame: CharacterState = { ...EMPTY_CHARACTER, phase: 'in-game', name: 'Brakkle' };
const soul: PeerGrant = { ...NO_PEER_GRANT, share: 'state' };

describe('which characters the gateway hears of', () => {
  it('none while sharing is off, whatever the rows say, and no key is made', async () => {
    const { subject, claimed, made } = sharing(false, { soul });
    const asked = claimed();
    subject.observe('brakkle', inGame);
    expect(await asked).toEqual([]);
    expect(made()).toBe(0);
  });

  it('none while no row shares or receives, and no key is made', async () => {
    const { subject, claimed, made } = sharing(true, { soul: NO_PEER_GRANT });
    const asked = claimed();
    subject.observe('brakkle', inGame);
    expect(await asked).toEqual([]);
    expect(made()).toBe(0);
  });

  it('a character the realm named, with its shares, once a row shares; and one that only receives', async () => {
    const shares = sharing(true, { soul: { ...soul, keys: [pair.publicKey] } });
    const asked = shares.claimed();
    shares.subject.observe('brakkle', inGame);
    expect(await asked).toEqual([
      {
        peer: { realm: REALM, name: 'Brakkle' },
        pair,
        shares: [{ name: 'soul', share: 'state', keys: [pair.publicKey] }]
      }
    ]);

    const receives = sharing(true, { soul: { ...NO_PEER_GRANT, receive: true } });
    const heard = receives.claimed();
    receives.subject.observe('brakkle', inGame);
    expect((await heard).map((each) => each.shares)).toEqual([[]]);
  });

  it('nothing before the realm has named the character', async () => {
    const { subject, claimed } = sharing(true, { soul });
    const asked = claimed();
    subject.observe('brakkle', { ...inGame, phase: 'authenticating' });
    subject.refresh();
    expect(await asked).toEqual([]);
  });
});
