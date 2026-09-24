/**
 * What a realm menu says about hanging up, and which realm was chosen (todo 01).
 *
 * Paradigm's menu lists each realm with its mode and, under one that charges
 * for it, `Hang Penalties 25%`. The choice is the next command after `Please
 * select a realm:`, the login script's or the player's. A realm marked `PvE`
 * that states no figure charges nothing; a PvP realm that states none is not
 * read, and the setting decides. See `mudengine-automation` › *Hanging up is
 * how you die, not how you escape*.
 */
import type { Block } from '../../shared/blocks';

/** The realm chosen off a menu that said what a hang-up costs there. */
export interface RealmHangPenalty {
  realm: string;
  /** A share of maximum health, as the menu printed it; 0 charges nothing. */
  percent: number;
}

interface Listed {
  name: string;
  pve: boolean;
  percent: number | null;
}

export class RealmMenu {
  private readonly listed = new Map<string, Listed>();
  private latest: Listed | null = null;
  private asking = false;
  private chosen: RealmHangPenalty | null = null;

  /** What the chosen realm charges, or null where no menu said. */
  get penalty(): RealmHangPenalty | null {
    return this.chosen;
  }

  onBlock(block: Block): void {
    switch (block.type) {
      case 'realm-listed': {
        const number = block.groups['number'];
        const name = block.groups['name'];
        if (number === undefined || name === undefined) return;
        // A menu drawn again after it was answered is a new menu.
        if (this.asking) this.forgetMenu();
        this.latest = { name, pve: block.groups['mode'] === 'PvE', percent: null };
        this.listed.set(number, this.latest);
        return;
      }
      case 'realm-hang-penalty': {
        const percent = Number(block.groups['percent']);
        if (this.latest !== null && Number.isFinite(percent)) this.latest.percent = percent;
        return;
      }
      case 'prompt-realm':
        this.asking = this.listed.size > 0;
        return;
      default:
        return;
    }
  }

  /**
   * A command went out. At the realm prompt it is the choice, and a choice the
   * menu can answer is returned so the session can say what it read.
   */
  noteCommand(command: string): RealmHangPenalty | null {
    if (!this.asking) return null;
    const row = this.listed.get(command.trim());
    this.forgetMenu();
    // Any answer here replaces the last choice: an unlisted one is not read,
    // never the previous realm's figure left standing.
    this.chosen = null;
    if (row === undefined) return null;
    const percent = row.percent ?? (row.pve ? 0 : null);
    this.chosen = percent === null ? null : { realm: row.name, percent };
    return this.chosen;
  }

  reset(): void {
    this.forgetMenu();
    this.chosen = null;
  }

  private forgetMenu(): void {
    this.listed.clear();
    this.latest = null;
    this.asking = false;
  }
}
