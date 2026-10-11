/*
 * The saved gear between a death and `recover corpse` (todo 82): a death holds
 * each saved slot to what was in it, spare gear worn meanwhile is not saved,
 * and each slot frees when its item is carried again. Fed through the
 * classifier, so the one writer (`rememberGear`) is what is tested.
 */
import { describe, expect, it } from 'vitest';
import { Classifier } from '../Classifier';
import { CharacterTracker } from '../CharacterTracker';

function feeder() {
  const classifier = new Classifier();
  const tracker = new CharacterTracker();
  let seq = 0;
  const feed = (text: string): void => {
    seq += 1;
    const { block, batch } = classifier.classify({
      seq,
      at: 1_700_000_000_000 + seq,
      text,
      plain: text,
      terminator: 'newline'
    });
    tracker.apply(block);
    if (batch) tracker.apply(batch, batch.rows);
  };
  const listing = (carrying: string): void => {
    feed(`You are carrying ${carrying}`);
    feed('You have no keys.');
    feed('Wealth: 0 copper farthings');
    feed('Encumbrance: 868/4800 - Light [18%]');
    feed('[HP=334/KAI=27]:');
  };
  const slot = (name: string) => tracker.current.loadout.find((worn) => worn.slot === name);
  return { tracker, feed, listing, slot };
}

/** Dressed in a longsword and a padded helm, then killed. */
function died() {
  const fed = feeder();
  fed.listing('longsword (Weapon Hand), padded helm (Head)');
  fed.feed('You have been killed!');
  return fed;
}

describe('the saved gear after a death', () => {
  it('locks every saved slot at the death', () => {
    const { tracker } = died();
    expect(tracker.current.loadout.every((worn) => worn.locked !== null)).toBe(true);
  });

  it('does not save spare gear worn before the corpse is recovered', () => {
    const { listing, slot } = died();
    listing('club (Weapon Hand)');
    expect(slot('Weapon Hand')?.item).toBe('longsword');
    expect(slot('Weapon Hand')?.locked).not.toBeNull();
  });

  it('frees a slot when its item is taken back, and leaves the others held', () => {
    const { feed, slot } = died();
    feed('You took padded helm.');
    expect(slot('Head')?.locked).toBeNull();
    expect(slot('Weapon Hand')?.locked).not.toBeNull();
  });

  /*
   * The case that makes the re-equip work: taken back while the club is still
   * on, the slot stays held, or the next listing would save the club and
   * Re-equip Gear would find nothing to put on.
   */
  it('keeps a slot held while spare gear still fills it', () => {
    const { feed, listing, slot } = died();
    listing('club (Weapon Hand)');
    feed('You took longsword.');
    expect(slot('Weapon Hand')?.locked).not.toBeNull();
    listing('longsword (Weapon Hand), club');
    expect(slot('Weapon Hand')).toMatchObject({ item: 'longsword', locked: null });
  });

  it('frees a slot when the same item is bought, and not for another', () => {
    const { feed, slot } = died();
    feed('You just bought broadsword for 78 gold crowns.');
    expect(slot('Weapon Hand')?.locked).not.toBeNull();
    feed('You just bought longsword for 78 gold crowns.');
    expect(slot('Weapon Hand')?.locked).toBeNull();
  });

  it('keeps the first death’s gear through a second death', () => {
    const { feed, listing, slot } = died();
    const first = slot('Weapon Hand')?.locked?.at;
    feed('You took padded helm.');
    listing('club (Weapon Hand), iron helm (Head), padded helm');
    feed('You have been killed!');
    expect(slot('Weapon Hand')).toMatchObject({ item: 'longsword', locked: { at: first } });
    expect(slot('Head')?.item).toBe('iron helm');
    expect(slot('Head')?.locked?.at).toBeGreaterThan(first ?? Infinity);
  });

  it('learns again once the tracker is told the allowance ran out', () => {
    const { tracker, listing, slot } = died();
    listing('club (Weapon Hand)');
    expect(tracker.releaseGearLocks(['Weapon Hand'], 1_800_000_000_000)).toBe(true);
    expect(slot('Weapon Hand')).toMatchObject({ item: 'club', locked: null });
    expect(slot('Head')?.locked).not.toBeNull();
  });

  it('leaves the slots whose items are still in the corpse held when it remains', () => {
    const { feed, slot } = died();
    feed('You took padded helm.');
    feed('The corpse of Probe remains.');
    expect(slot('Head')?.locked).toBeNull();
    expect(slot('Weapon Hand')?.locked).not.toBeNull();
  });
});
