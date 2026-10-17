import {
  sourcesBeneath,
  type MobRule,
  type MobRuleLayer,
  type MobRuleScope
} from '../../shared/mobRules';

/** Where each broader monster list is read from, as saved. */
export interface MobRuleSources {
  megamud(): readonly MobRule[];
  global(): readonly MobRule[];
  realm(name: string): readonly MobRule[];
}

/**
 * The lists a settings form's own sits on, broadest first (todo 817):
 * MegaMUD's table, the options file's, and beneath a character its realm's.
 * The settings screen's `InheritedMobRules` draws them.
 */
export function mobRuleLayers(
  scope: MobRuleScope,
  realm: string,
  sources: MobRuleSources
): MobRuleLayer[] {
  return sourcesBeneath(scope).map((source) => {
    switch (source) {
      case 'megamud':
        return { source, rows: sources.megamud() };
      case 'global':
        return { source, rows: sources.global() };
      case 'realm':
        return { source, rows: sources.realm(realm) };
      default: {
        const unreachable: never = source;
        return unreachable;
      }
    }
  });
}
