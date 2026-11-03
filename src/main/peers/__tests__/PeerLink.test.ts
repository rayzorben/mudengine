import { describe, expect, it } from 'vitest';

import { newEd25519Pair } from '../../../node/ed25519';
import type { PeerSheet } from '../../../shared/peers';
import type { ShareEntry } from '../../../shared/peerWire';
import type { Claimant } from '../PeerLink';
import { peerSheetOf } from '../peerSheet';
import { brakkle, install, soul, state, until, useGateway } from './peerHarness';

useGateway();

describe('a share between two installs', () => {
  it('reports the receiver to the sharer unpinned, then streams to it once pinned', async () => {
    const sharer = install();
    const receiver = install();
    const brakklePair = newEd25519Pair();
    const soulPair = newEd25519Pair();
    const share = (keys: string[]): Claimant => ({
      peer: brakkle,
      pair: brakklePair,
      shares: [{ name: 'Soul', share: 'state', keys } satisfies ShareEntry]
    });
    sharer.link.want([share([])]);
    sharer.link.observe(brakkle, peerSheetOf(state(70)));
    receiver.link.want([{ peer: soul, pair: soulPair, shares: [] }]);

    // Unpinned: the sharer is told of Soul's claim, and Soul is sent nothing.
    await until(() => sharer.unpinned.length > 0, sharer.changed);
    expect(sharer.unpinned).toEqual([{ name: 'Soul', key: soulPair.publicKey }]);
    const accepts = (): { receive: boolean; keys: string[] } => ({
      receive: true,
      keys: [brakklePair.publicKey]
    });
    expect(receiver.book.sheetsFor(soul, accepts)).toEqual([]);

    // The control: the same share, Soul's key pinned, reaches Soul whole and then as changes.
    sharer.link.want([share([soulPair.publicKey])]);
    await until(() => receiver.book.sheetsFor(soul, accepts).length > 0, receiver.changed);
    expect(receiver.book.sheetsFor(soul, accepts)[0]!.sheet.vitals?.hp).toBe(70);
    sharer.link.observe(brakkle, peerSheetOf(state(31)));
    await until(
      () => receiver.book.sheetsFor(soul, accepts)[0]?.sheet.vitals?.hp === 31,
      receiver.changed
    );
    const sheet: PeerSheet = receiver.book.sheetsFor(soul, accepts)[0]!.sheet;
    expect(sheet).toEqual(peerSheetOf(state(31)));
    expect(sharer.said).toEqual([]);
  });

  it('shows a receiver only what its player accepted, under a key the player pinned', async () => {
    const sharer = install();
    const receiver = install();
    const brakklePair = newEd25519Pair();
    const soulPair = newEd25519Pair();
    sharer.link.want([
      {
        peer: brakkle,
        pair: brakklePair,
        shares: [{ name: 'Soul', share: 'state', keys: [soulPair.publicKey] }]
      }
    ]);
    sharer.link.observe(brakkle, peerSheetOf(state(70)));
    receiver.link.want([{ peer: soul, pair: soulPair, shares: [] }]);
    const pinned = (): { receive: boolean; keys: string[] } => ({
      receive: true,
      keys: [brakklePair.publicKey]
    });
    await until(() => receiver.book.sheetsFor(soul, pinned).length > 0, receiver.changed);

    // Not accepted: nothing shown, and no offer either.
    const refused = (): { receive: boolean; keys: string[] } => ({ receive: false, keys: [] });
    expect(receiver.book.sheetsFor(soul, refused)).toEqual([]);
    expect(receiver.book.offersFor(soul, refused)).toEqual([]);
    // Accepted by name, the key not pinned: an offer to pin, and no sheet.
    const unpinned = (): { receive: boolean; keys: string[] } => ({ receive: true, keys: [] });
    expect(receiver.book.sheetsFor(soul, unpinned)).toEqual([]);
    expect(receiver.book.offersFor(soul, unpinned)).toEqual([
      { name: 'Brakkle', key: brakklePair.publicKey }
    ]);
  });

  it('takes every sheet away when the sharer leaves', async () => {
    const sharer = install();
    const receiver = install();
    const brakklePair = newEd25519Pair();
    const soulPair = newEd25519Pair();
    sharer.link.want([
      {
        peer: brakkle,
        pair: brakklePair,
        shares: [{ name: 'Soul', share: 'state', keys: [soulPair.publicKey] }]
      }
    ]);
    sharer.link.observe(brakkle, peerSheetOf(state(70)));
    receiver.link.want([{ peer: soul, pair: soulPair, shares: [] }]);
    const accepts = (): { receive: boolean; keys: string[] } => ({
      receive: true,
      keys: [brakklePair.publicKey]
    });
    await until(() => receiver.book.sheetsFor(soul, accepts).length > 0, receiver.changed);
    expect(sharer.link.link).toBe('connected');

    // Nothing shared: the sharer's socket closes, and the receiver hears it gone.
    sharer.link.want([]);
    expect(sharer.link.link).toBe('off');
    await until(() => receiver.book.sheetsFor(soul, accepts).length === 0, receiver.changed);
  });
});
