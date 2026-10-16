/**
 * A character's own aliases and keys (todo 134), each added to Global's: one
 * unit, since a key and an alias may call each other and a loop between them,
 * or through what it inherits, is said on the rows.
 */
import AliasFields from './AliasFields';
import KeyFields from './KeyFields';

import { useLoopingMacros } from '../hooks/useLoopingMacros';
import type { CharacterFields } from '../lib/characterForm';
import type { StatedPair } from '@shared/pairs';

export interface MacroSectionsProps {
  form: Pick<CharacterFields, 'aliases' | 'keys' | 'macroBase'>;
  patch(change: { aliases: StatedPair[] } | { keys: StatedPair[] }): void;
}

export default function MacroSections({ form, patch }: MacroSectionsProps) {
  const { aliases, keys, macroBase } = form;
  const looping = useLoopingMacros(keys, aliases, macroBase);
  return (
    <>
      <AliasFields
        aliases={aliases}
        character
        looping={looping}
        onChange={(next) => patch({ aliases: next })}
      />
      <KeyFields
        character
        keys={keys}
        looping={looping}
        onChange={(next) => patch({ keys: next })}
      />
    </>
  );
}
