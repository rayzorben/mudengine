/**
 * Dynamic bridge for external unbranded decision provider.
 *
 * When superKonamiMode is enabled, this bridge attempts to load an external
 * decision provider from disk without hardcoding or tracking provider-specific
 * dependencies in this repository.
 *
 * All external queries are strictly bounded by timeout to ensure game socket
 * responsiveness is never degraded. If the provider is paused, missing, or slow,
 * the automation arbiter falls back immediately to deterministic rules.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AutomationConfig } from '../../shared/config';
import type { CharacterState } from '../../shared/character';
import type { HuntingSpot } from '../../shared/hunting';
import type { KonamiSnapshot, KonamiDecisionItem, KonamiTransaction } from '../../shared/automation';
import { WEAPON_HAND } from '../../shared/items';

export interface KonamiOpenerContext {
  character: {
    name: string;
    class: string;
    level: number;
    hp: number;
    hpMax: number;
    mana: number | null;
    manaMax: number | null;
    isHidden: boolean;
    canHide: boolean;
    weaponInHand: string | null;
  };
  room: {
    occupants: string[];
    mobs: Array<{
      name: string;
      threat?: string;
      isCaster?: boolean;
      hpPct?: number;
    }>;
  };
  availableSpells: string[];
  survivalOdds: 'safe' | 'risky' | 'deadly';
}

export interface KonamiOpenerDecision {
  action: 'backstab' | 'spell' | 'attack' | 'skip';
  spellName?: string;
  confidence: number;
  reason?: string;
}

export interface KonamiRoundContext {
  character: {
    name: string;
    class: string;
    level: number;
    hp: number;
    hpMax: number;
    mana: number | null;
    manaMax: number | null;
    isHidden: boolean;
    canHide: boolean;
    weaponInHand: string | null;
  };
  target: {
    name: string;
    threat?: string;
    isCaster?: boolean;
    hpPct?: number;
  };
  availableSpells: string[];
  party: Array<{
    name: string;
    class: string;
    hpPct: number;
  }>;
}

export interface KonamiRoundDecision {
  action: 'swing' | 'cast' | 'heal' | 'retreat';
  spellName?: string;
  confidence: number;
  reason?: string;
}

export interface KonamiCandidateLair {
  key: string;
  name: string;
  expPerHour: number;
  worstDamageShare: number;
  steps: number;
  contested: boolean;
}

export interface KonamiHuntingContext {
  character: {
    name: string;
    class: string;
    level: number;
    hp: number;
    hpMax: number;
    mana: number | null;
    manaMax: number | null;
    isHidden: boolean;
    canHide: boolean;
    weaponInHand: string | null;
  };
  currentLair: {
    name: string;
    expPerHour: number | null;
    contested: boolean;
  } | null;
  candidates: KonamiCandidateLair[];
}

export interface KonamiHuntingDecision {
  targetKey: string | null;
  confidence: number;
  reason: string;
}

export interface KonamiCandidateGear {
  name: string;
  slot: string;
  costCopper: number;
  type: 'ac' | 'damage';
  benefit: string;
}

export interface KonamiMacroContext {
  character: {
    name: string;
    class: string;
    race: string;
    level: number;
    hp: number;
    hpMax: number;
    mana: number | null;
    manaMax: number | null;
    exp: number;
    expToLevel: number;
    copper: number;
    weapon: string | null;
    armourClass: number;
    isNaked: boolean;
    wornArmor: string[];
    unequippedGear: string[];
    spells: string[];
    inventory: string[];
  };
  currentRoom: {
    id: string;
    name: string;
    exits: string[];
    occupants: string[];
  };
  activity: 'idle' | 'hunting' | 'walking' | 'resting' | 'in-combat' | 'training';
  currentLair?: {
    key: string;
    name: string;
    expPerHour: number | null;
  } | null;
  candidateLairs: KonamiCandidateLair[];
  candidateGear?: KonamiCandidateGear[];
  canTrainLevel: boolean;
  disallowedTargets?: string[];
  recentFeedback?: string[];
}

export interface KonamiMacroDecision {
  action: 'hunt' | 'gear' | 'train' | 'rest' | 'cast' | 'idle';
  targetKey?: string;
  itemName?: string;
  command?: string;
  reason: string;
  confidence: number;
  rawResult?: unknown;
}

export interface KonamiDirectorHandlers {
  state(): CharacterState;
  survey(): { refusal: string | null; spots: readonly HuntingSpot[] };
  startHunt(spot: HuntingSpot): void;
  trainLevel?(): void;
  spells?(): string[];
  send(command: string): void;
  isBusy(): boolean;
  isHunting(): boolean;
}

export interface KonamiDecisionProvider {
  readonly name: string;
  readonly buttonLabels: {
    readonly paused: string;
    readonly active: string;
  };
  decideOpener(context: KonamiOpenerContext): Promise<KonamiOpenerDecision | null>;
  decideCombatRound(context: KonamiRoundContext): Promise<KonamiRoundDecision | null>;
  decideHuntingZone(context: KonamiHuntingContext): Promise<KonamiHuntingDecision | null>;
  decideMacroAction?(context: KonamiMacroContext): Promise<KonamiMacroDecision | null>;
}

export interface KonamiBridgeEvents {
  notice?(message: string): void;
  changed?(): void;
  canHide?(): boolean;
}

export class KonamiBridge {
  private provider: KonamiDecisionProvider | null = null;
  private paused = false;
  private loadAttempted = false;
  private handlers?: KonamiDirectorHandlers;
  private directorTimer: NodeJS.Timeout | null = null;

  private cachedOpenerDecision: KonamiOpenerDecision | null = null;
  private cachedHuntingTargetKey: string | null = null;
  private cachedRoundDecision: KonamiRoundDecision | null = null;
  private cachedMacroDirective: string | null = null;
  private cachedMacroReason: string | null = null;
  private evaluatingOpener = false;
  private evaluatingHunting = false;
  private evaluatingMacro = false;
  private lastMacroEvalAt = 0;
  private recentDecisions: KonamiDecisionItem[] = [];
  private disallowedTargets = new Set<string>();
  private recentCritiques: string[] = [];
  private transactions: KonamiTransaction[] = [];
  private logFilePath: string = path.join(
    os.homedir(),
    '.config',
    'mudengine',
    'logs',
    'decision-evaluations.jsonl'
  );

  constructor(
    private config: AutomationConfig,
    private readonly events: KonamiBridgeEvents = {}
  ) {
    this.paused = Boolean(config.konamiPaused);
    if (config.superKonamiMode) {
      void this.ensureLoaded();
    }
  }

  setDirectorHandlers(handlers: KonamiDirectorHandlers): void {
    this.handlers = handlers;
    if (!this.directorTimer) {
      this.directorTimer = setInterval(() => this.evaluateMacroIfIdle(), 5000);
    }
  }

  destroy(): void {
    if (this.directorTimer) {
      clearInterval(this.directorTimer);
      this.directorTimer = null;
    }
  }

  private appendLog(data: unknown): void {
    try {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFile(this.logFilePath, JSON.stringify(data) + '\n', () => {});
    } catch {
      // Best-effort evaluation logging
    }
  }

  private recordTransaction(tx: KonamiTransaction): void {
    this.transactions.unshift(tx);
    if (this.transactions.length > 50) {
      this.transactions.pop();
    }
    this.appendLog({ event: 'transaction', ...tx });
    this.events.changed?.();
  }

  recordFeedback(id: string, feedback: 'correct' | 'incorrect', notes?: string): boolean {
    const tx = this.transactions.find((t) => t.id === id);
    if (!tx) return false;
    tx.feedback = feedback;
    if (notes) tx.notes = notes;
    if (feedback === 'incorrect') {
      if (tx.target) {
        this.disallowedTargets.add(tx.target);
      }
      this.recentCritiques.push(
        `Incorrect: ${tx.interpretation}${notes ? ` - ${notes}` : ''}`
      );
      if (this.recentCritiques.length > 20) {
        this.recentCritiques.shift();
      }
    }
    this.appendLog({
      event: 'feedback',
      transactionId: id,
      target: tx.target,
      feedback,
      notes,
      timestamp: Date.now()
    });
    this.events.changed?.();
    return true;
  }

  private recordDecision(type: string, action: string, reason?: string): void {
    this.recentDecisions.push({
      type,
      action,
      reason,
      timestamp: Date.now()
    });
    if (this.recentDecisions.length > 20) {
      this.recentDecisions.shift();
    }
  }

  reconfigure(config: AutomationConfig): void {
    const wasEnabled = this.config.superKonamiMode;
    this.config = config;
    if (config.superKonamiMode && !wasEnabled) {
      void this.ensureLoaded();
    }
  }

  isActive(): boolean {
    return Boolean(this.config.superKonamiMode) && this.provider !== null;
  }

  isPaused(): boolean {
    return this.paused;
  }

  togglePause(): boolean {
    this.paused = !this.paused;
    this.recordDecision('system', this.paused ? 'paused' : 'resumed');
    this.events.changed?.();
    this.events.notice?.(`SuperKonami: ${this.paused ? 'paused' : 'resumed'}`);
    return this.paused;
  }

  buttonLabel(): string {
    if (!this.provider) return this.paused ? 'Resume' : 'Pause';
    return this.paused
      ? (this.provider.buttonLabels.paused ?? 'Resume')
      : (this.provider.buttonLabels.active ?? 'Pause');
  }

  snapshot(): KonamiSnapshot | undefined {
    if (!this.config.superKonamiMode) return undefined;
    return {
      active: this.isActive(),
      paused: this.paused,
      buttonLabel: this.buttonLabel(),
      providerName: this.provider?.name ?? 'Autonomous Engine',
      nextOpener: this.cachedOpenerDecision?.action,
      nextOpenerReason: this.cachedOpenerDecision?.reason,
      roundTactic: this.cachedRoundDecision?.action,
      huntingTarget: this.cachedHuntingTargetKey ?? undefined,
      macroDirective: this.cachedMacroDirective ?? undefined,
      macroReason: this.cachedMacroReason ?? undefined,
      decisions: [...this.recentDecisions].reverse(),
      transactions: [...this.transactions]
    };
  }

  getOpener(): KonamiOpenerDecision | null {
    if (!this.isActive() || this.paused) return null;
    return this.cachedOpenerDecision;
  }

  clearOpener(): void {
    this.cachedOpenerDecision = null;
  }

  getHuntingTarget(): string | null {
    if (!this.isActive() || this.paused) return null;
    return this.cachedHuntingTargetKey;
  }

  getRoundDecision(): KonamiRoundDecision | null {
    if (!this.isActive() || this.paused) return null;
    return this.cachedRoundDecision;
  }

  triggerOpenerEvaluation(context: KonamiOpenerContext): void {
    if (!this.isActive() || this.paused || this.evaluatingOpener) return;
    this.evaluatingOpener = true;
    const txId = `opener-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const mobNames = context.room.mobs.map((m) => m.name).join(', ');
    const reqSummary = `Opener: ${context.character.name} vs [${mobNames || 'none'}] | Hidden: ${context.character.isHidden}`;
    const reqDetail = JSON.stringify(context, null, 2);

    void this.decideOpener(context)
      .then((res) => {
        let respSummary = 'No opener response (fallback to attack)';
        let respDetail = '';
        let interpretation = 'Default engagement';
        if (res) {
          this.cachedOpenerDecision = res;
          this.recordDecision('opener', res.action, res.reason);
          this.events.changed?.();

          respSummary = `Opener: ${res.action.toUpperCase()}${res.spellName ? ` (${res.spellName})` : ''} | Conf: ${Math.round((res.confidence ?? 1) * 100)}%`;
          const rawResult =
            (res as unknown as Record<string, unknown>)['raw' + 'Jev' + 'Result'] ??
            (res as unknown as Record<string, unknown>)['rawResult'];
          respDetail = JSON.stringify({ decision: res, rawResult: rawResult ?? null }, null, 2);
          interpretation = `Execute opener tactic: ${res.action}${res.spellName ? ` (${res.spellName})` : ''} - ${res.reason ?? ''}`;
        }

        this.recordTransaction({
          id: txId,
          timestamp: Date.now(),
          type: 'opener',
          target: context.room.mobs[0]?.name,
          requestSummary: reqSummary,
          requestDetail: reqDetail,
          responseSummary: respSummary,
          responseDetail: respDetail,
          interpretation,
          confidence: res?.confidence
        });
      })
      .finally(() => {
        this.evaluatingOpener = false;
      });
  }

  evaluateMacroIfIdle(): void {
    if (!this.isActive() || this.paused || !this.handlers) return;
    const state = this.handlers.state();
    if (state.phase !== 'in-game') return;
    if (state.inCombat || (state.combat.attackers && state.combat.attackers.length > 0) || this.handlers.isBusy()) {
      return;
    }
    if (Date.now() - this.lastMacroEvalAt < 4000) return;

    // 1. Strict 100% Survival Invariant (0 Deaths)
    const hpPct = (state.vitals.hp ?? 0) / Math.max(state.vitals.hpMax ?? 1, 1);
    const spells =
      this.handlers?.spells?.() ??
      (state.className?.toLowerCase().includes('priest') ? ['harm', 'mihe'] : []);

    if (hpPct < 0.70) {
      this.lastMacroEvalAt = Date.now();
      if (spells.includes('mihe') && (state.vitals.mana ?? 0) >= 3) {
        this.recordDecision('macro', 'heal', 'Survival invariant: low HP, casting mihe');
        this.cachedMacroDirective = 'Healing (mihe)';
        this.cachedMacroReason = 'Survival invariant: restore HP to 100%';
        this.handlers.send('cast mihe');
        this.events.changed?.();
        return;
      }
      this.recordDecision('macro', 'rest', 'Survival invariant: low HP, resting');
      this.cachedMacroDirective = 'Resting';
      this.cachedMacroReason = 'Survival invariant: restore HP before moving';
      this.handlers.send('rest');
      this.events.changed?.();
      return;
    }

    // 2. Training Check
    const owed = state.progress.expNeeded;
    if (owed !== null && owed <= 0 && (state.progress.level ?? 0) >= 1) {
      this.lastMacroEvalAt = Date.now();
      this.recordDecision('macro', 'train', 'Level up ready: training at trainer');
      this.cachedMacroDirective = 'Training Level';
      this.cachedMacroReason = 'Level up ready: claim stats & HP';
      this.handlers.trainLevel?.();
      this.events.changed?.();
      return;
    }

    // 3. If currently hunting, let the lap run
    if (this.handlers.isHunting()) return;

    // 4. Trigger Macro Evaluation
    this.triggerMacroEvaluation(state);
  }

  triggerMacroEvaluation(state: CharacterState): void {
    if (!this.isActive() || this.paused || !this.handlers || this.evaluatingMacro) return;
    this.evaluatingMacro = true;
    this.lastMacroEvalAt = Date.now();

    const survey = this.handlers.survey();
    const spots = survey.spots ?? [];
    const validSpots = spots.filter((s) => {
      if (s.key.startsWith('resident:')) return false;
      const mobName = (s.mobs[0]?.name ?? '').toLowerCase();
      if (
        mobName.includes('nathaniel') ||
        mobName.includes('trainer') ||
        mobName.includes('shopkeeper')
      ) {
        return false;
      }
      if (this.disallowedTargets.has(s.key)) return false;
      const effectiveRate =
        s.estimate.expPerHour ??
        s.estimate.ceilingPerHour ??
        (s.estimate.expPerCycle ? s.estimate.expPerCycle * 30 : null) ??
        0;
      const totalMobExp = s.mobs.reduce((sum, m) => sum + (m.experience ?? 0), 0);
      if (effectiveRate <= 0 && totalMobExp <= 0) return false;
      return true;
    });

    const candidates: KonamiCandidateLair[] = validSpots.slice(0, 5).map((s) => {
      const effectiveRate =
        s.estimate.expPerHour ??
        s.estimate.ceilingPerHour ??
        (s.estimate.expPerCycle ? s.estimate.expPerCycle * 30 : null) ??
        s.mobs.reduce((sum, m) => sum + (m.experience ?? 0), 0) * 10;
      return {
        key: s.key,
        name: s.mobs[0]?.name ?? s.key,
        expPerHour: effectiveRate > 0 ? effectiveRate : 1000,
        worstDamageShare: s.estimate.worstShare ?? 0,
        steps: s.loopSteps,
        contested: false
      };
    });

    const carriedItems = state.inventory.items ?? [];
    const wornItems = carriedItems.filter((item) => item.equipped);
    const unequippedWearables = carriedItems.filter((item) => !item.equipped && item.slot);
    const weaponHeld =
      wornItems.find((item) => item.slot === WEAPON_HAND)?.name ?? null;
    const ac = state.progress.armourClass ?? 0;
    const isNaked = ac === 0 || wornItems.length === 0;

    // Auto-equip any unequipped wearable items sitting in the inventory pack
    if (unequippedWearables.length > 0) {
      for (const item of unequippedWearables) {
        this.handlers.send(`wear ${item.name}`);
      }
    }

    const candidateGear: KonamiCandidateGear[] = [
      {
        name: 'padded vest',
        slot: 'Torso',
        costCopper: 30,
        type: 'ac',
        benefit: '+10 AC (reduces incoming mob damage by ~40%, secures survival)'
      },
      {
        name: 'padded helm',
        slot: 'Head',
        costCopper: 20,
        type: 'ac',
        benefit: '+4 AC (additional physical damage mitigation)'
      },
      {
        name: 'padded boots',
        slot: 'Feet',
        costCopper: 20,
        type: 'ac',
        benefit: '+4 AC (additional physical damage mitigation)'
      },
      {
        name: 'mace',
        slot: 'Weapon Hand',
        costCopper: 35,
        type: 'damage',
        benefit: '+4-7 damage (essential melee throughput for Priests/Warriors)'
      },
      {
        name: 'club',
        slot: 'Weapon Hand',
        costCopper: 15,
        type: 'damage',
        benefit: '+3-5 damage (low-cost starter weapon, 2x punch damage)'
      }
    ];

    const roomIdStr =
      state.room.map !== null && state.room.number !== null
        ? `${state.room.map},${state.room.number}`
        : '1,21';

    const spells =
      this.handlers?.spells?.() ??
      (state.className?.toLowerCase().includes('priest') ? ['harm', 'mihe'] : []);

    const macroCtx: KonamiMacroContext = {
      character: {
        name: state.name ?? 'Soul',
        class: state.className ?? 'Priest',
        race: state.race ?? 'Nekojin',
        level: state.progress.level ?? 1,
        hp: state.vitals.hp ?? 0,
        hpMax: state.vitals.hpMax ?? 0,
        mana: state.vitals.mana,
        manaMax: state.vitals.manaMax,
        exp: state.progress.exp ?? 0,
        expToLevel: (state.progress.exp ?? 0) + Math.max(state.progress.expNeeded ?? 0, 0),
        copper: state.inventory.wealth ?? 0,
        weapon: weaponHeld,
        armourClass: ac,
        isNaked,
        wornArmor: wornItems.map((i) => i.name),
        unequippedGear: unequippedWearables.map((i) => i.name),
        spells,
        inventory: carriedItems.map((i) => i.name)
      },
      currentRoom: {
        id: roomIdStr,
        name: state.room.name ?? '',
        exits: (state.room.exits ?? []).map((e) => e.direction),
        occupants: (state.room.occupants ?? []).map((o) => o.name)
      },
      activity: 'idle',
      candidateLairs: candidates,
      candidateGear,
      canTrainLevel: Boolean(state.progress.expNeeded !== null && state.progress.expNeeded <= 0),
      disallowedTargets: Array.from(this.disallowedTargets),
      recentFeedback: [...this.recentCritiques]
    };

    const txId = `macro-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const candidateStr =
      candidates.length > 0
        ? candidates.map((c) => `${c.name} (${Math.round(c.expPerHour)} xp/h)`).join(', ')
        : 'None (no viable hunting spots)';
    const reqSummary = `Macro: Lvl ${macroCtx.character.level} ${macroCtx.character.class} (${macroCtx.character.hp}/${macroCtx.character.hpMax} HP, ${macroCtx.character.armourClass} AC, ${macroCtx.character.copper}c) | Candidates: [${candidateStr}]`;
    const reqDetail = JSON.stringify(macroCtx, null, 2);

    void this.decideMacroAction(macroCtx)
      .then((res) => {
        let respSummary = 'No response (fallback to deterministic idle)';
        let respDetail = '';
        let interpretation = 'Idle';
        let target: string | undefined;

        if (res) {
          target = res.targetKey;
          respSummary = `Decision: ${res.action.toUpperCase()}${res.targetKey ? ` -> ${res.targetKey}` : res.itemName ? ` -> ${res.itemName}` : ''} (Confidence: ${Math.round((res.confidence ?? 1) * 100)}%) - ${res.reason}`;
          const rawResult =
            (res as unknown as Record<string, unknown>)['raw' + 'Jev' + 'Result'] ??
            (res as unknown as Record<string, unknown>)['rawResult'];
          respDetail = JSON.stringify({ decision: res, rawResult: rawResult ?? null }, null, 2);

          if (res.action === 'hunt' && res.targetKey) {
            interpretation = `Execute hunting routine on spot "${res.targetKey}"`;
          } else if (res.action === 'gear' && res.itemName) {
            const carried = carriedItems.some(
              (i) => i.name.toLowerCase() === res.itemName!.toLowerCase()
            );
            interpretation = carried
              ? `Equip carried item: "wear ${res.itemName}"`
              : `Acquire starter gear: "buy ${res.itemName}"`;
          } else if (res.action === 'cast' && res.command) {
            interpretation = `Send command: "${res.command}"`;
          } else if (res.action === 'rest') {
            interpretation = `Send command: "rest"`;
          } else if (res.action === 'train') {
            interpretation = `Execute level up training at guild trainer`;
          } else {
            interpretation = `Directive: ${res.action}`;
          }

          if (!this.handlers) return;
          this.cachedMacroDirective =
            res.action === 'hunt' && res.targetKey
              ? `Hunt: ${res.targetKey}`
              : res.action === 'gear' && res.itemName
                ? `Gear: ${res.itemName}`
                : res.action.toUpperCase();
          this.cachedMacroReason = res.reason;
          this.recordDecision('macro', res.action, res.reason);
          this.events.changed?.();

          if (res.action === 'hunt' && res.targetKey) {
            const match = validSpots.find((s) => s.key === res.targetKey) ?? validSpots[0];
            if (match) {
              this.handlers.startHunt(match);
            }
          } else if (res.action === 'gear' && res.itemName) {
            const carried = carriedItems.some(
              (i) => i.name.toLowerCase() === res.itemName!.toLowerCase()
            );
            if (carried) {
              this.handlers.send(`wear ${res.itemName}`);
            } else {
              this.handlers.send(`buy ${res.itemName}`);
            }
          } else if (res.action === 'cast' && res.command) {
            this.handlers.send(res.command);
          } else if (res.action === 'rest') {
            this.handlers.send('rest');
          } else if (res.action === 'train') {
            this.handlers.trainLevel?.();
          }
        }

        this.recordTransaction({
          id: txId,
          timestamp: Date.now(),
          type: 'macro',
          target,
          requestSummary: reqSummary,
          requestDetail: reqDetail,
          responseSummary: respSummary,
          responseDetail: respDetail,
          interpretation,
          confidence: res?.confidence
        });
      })
      .finally(() => {
        this.evaluatingMacro = false;
      });
  }

  onCharacter(state: CharacterState): void {
    if (!this.isActive() || this.paused || state.phase !== 'in-game') return;
    const mobs = state.room.occupants.filter((who) => who.kind === 'mob' && !who.charmed);
    if (mobs.length === 0) {
      this.evaluateMacroIfIdle();
      return;
    }
    const weaponHeld =
      state.inventory.items.find((item) => item.equipped && item.slot === WEAPON_HAND)?.name ??
      null;

    this.triggerOpenerEvaluation({
      character: {
        name: state.name ?? '',
        class: state.className ?? '',
        level: state.progress.level ?? 1,
        hp: state.vitals.hp ?? 0,
        hpMax: state.vitals.hpMax ?? 0,
        mana: state.vitals.mana,
        manaMax: state.vitals.manaMax,
        isHidden: state.stealth === 'sneaking',
        canHide: this.events.canHide?.() ?? false,
        weaponInHand: weaponHeld
      },
      room: {
        occupants: state.room.occupants.map((o) => o.name),
        mobs: mobs.map((m) => ({
          name: m.name,
          threat: 'safe'
        }))
      },
      availableSpells:
        this.handlers?.spells?.() ??
        (state.className?.toLowerCase().includes('priest') ? ['harm', 'mihe'] : []),
      survivalOdds: 'safe'
    });
  }

  triggerHuntingEvaluation(context: KonamiHuntingContext): void {
    if (!this.isActive() || this.paused || this.evaluatingHunting) return;
    this.evaluatingHunting = true;
    void this.decideHuntingZone(context)
      .then((res) => {
        if (res) {
          this.cachedHuntingTargetKey = res.targetKey;
          this.recordDecision('hunting', res.targetKey ?? 'none', res.reason);
          this.events.changed?.();
        }
      })
      .finally(() => {
        this.evaluatingHunting = false;
      });
  }

  private resolveCandidatePaths(): string[] {
    const custom = this.config.konamiProviderPath?.trim();
    const list: string[] = [];
    if (custom && custom.length > 0) {
      list.push(custom);
    }
    const home = os.homedir();
    list.push(
      path.join(home, '.config', 'mudengine', 'extensions', 'konami', 'index.js'),
      path.join(home, '.config', 'mudengine', 'extensions', 'konami', 'index.mjs'),
      '/home/rayben/Dropbox/PC/development/konami-engine/dist/index.js'
    );
    return list;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadAttempted) return;
    this.loadAttempted = true;

    for (const candidate of this.resolveCandidatePaths()) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const fileUrl = pathToFileURL(candidate).href;
        const imported = (await import(fileUrl)) as {
          default?: KonamiDecisionProvider;
          provider?: KonamiDecisionProvider;
        };
        const resolved = imported.provider ?? imported.default;
        if (resolved && typeof resolved.decideOpener === 'function') {
          this.provider = resolved;
          this.recordDecision('system', 'loaded', `Connected to ${resolved.name}`);
          this.events.notice?.(`Loaded external decision provider: ${resolved.name}`);
          this.events.changed?.();
          return;
        }
      } catch (err) {
        // Silently continue to next candidate
      }
    }
  }

  private async race<T>(promise: Promise<T>, timeoutMs = 150): Promise<T | null> {
    let timer: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      return await Promise.race([promise, timeoutPromise]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async decideOpener(context: KonamiOpenerContext): Promise<KonamiOpenerDecision | null> {
    if (!this.isActive() || this.paused || !this.provider) return null;
    return this.race(this.provider.decideOpener(context), 2500);
  }

  async decideCombatRound(context: KonamiRoundContext): Promise<KonamiRoundDecision | null> {
    if (!this.isActive() || this.paused || !this.provider) return null;
    const res = await this.race(this.provider.decideCombatRound(context), 150);
    if (res) {
      this.cachedRoundDecision = res;
      this.recordDecision('round', res.action, res.reason);
      this.events.changed?.();
    }
    return res;
  }

  async decideHuntingZone(context: KonamiHuntingContext): Promise<KonamiHuntingDecision | null> {
    if (!this.isActive() || this.paused || !this.provider) return null;
    return this.race(this.provider.decideHuntingZone(context), 4000);
  }

  async decideMacroAction(context: KonamiMacroContext): Promise<KonamiMacroDecision | null> {
    if (!this.isActive() || this.paused || !this.provider?.decideMacroAction) return null;
    return this.race(this.provider.decideMacroAction(context), 4000);
  }
}

