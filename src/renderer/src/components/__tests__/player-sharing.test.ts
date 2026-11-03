import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import PlayerSharing from '../PlayerSharing';
import { mount } from '../../hooks/__tests__/mount';
import { NO_SHARES } from '@shared/peers';
import { NO_GRANT, type RemoteGrant } from '@shared/remotes';

/*
 * Todo 20261031-1156-01: Allow Remote Control on a player's Access tab. It is
 * offered only on a share, and turning it off lowers the share to the sheet
 * at once, with no prompt.
 */
const probe = mount();
afterEach(() => probe.unmount());

function draw(grant: RemoteGrant, set: (next: RemoteGrant) => void): void {
  probe.render(
    createElement(PlayerSharing, {
      character: 'Brakkle',
      player: 'Soul',
      grant,
      set,
      shares: NO_SHARES,
      onAsking: () => undefined
    })
  );
}

const controlField = () => probe.root().findAll((node) => node.props['name'] === 'player-control');

describe("a player's Allow Remote Control", () => {
  it('is offered only while the character is shared with them', () => {
    draw({ ...NO_GRANT, share: 'off' }, () => undefined);
    expect(controlField()).toEqual([]);
    // Positive control: shared, and the field is there.
    draw({ ...NO_GRANT, share: 'state' }, () => undefined);
    expect(controlField().length).toBeGreaterThan(0);
  });

  it('lowers the share to the sheet at once when turned off', () => {
    const saved: RemoteGrant[] = [];
    draw({ ...NO_GRANT, share: 'control' }, (next) => saved.push(next));
    const [field] = controlField();
    expect(field!.props['checked']).toBe(true);
    (field!.props['onChange'] as (on: boolean) => void)(false);
    expect(saved.map((each) => each.share)).toEqual(['state']);
  });
});
