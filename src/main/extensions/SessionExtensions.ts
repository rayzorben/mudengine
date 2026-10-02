/**
 * One character's extensions (todo 84): each installed extension's session,
 * handed what the session hears and asked for its card's view and its
 * buttons' answers. What an extension lays over the character's settings is
 * kept here and laid on every configure, in folder order.
 *
 * An extension is not this client's code, so every call into it is caught:
 * the first failure of each hook is said, the session carries on, and the
 * extension is asked again the next time.
 */
import { t } from '../app/i18n';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { withLayer, type LayerWrite } from '../../shared/extensions';
import { errorMessage } from '../../shared/values';
import type { SessionModule } from '../automation/Module';
import type { ExtensionSession, ExtensionSessionHost } from './api';
import type { LoadedExtension } from './ExtensionLoader';

/** What an extension's host is built from, besides what the session hands every one. */
export interface ExtensionHostKit {
  /** Lays this extension's settings, or lifts them (null), and configures the session again. */
  layer(writes: readonly LayerWrite[] | null): void;
  /** Whether this extension is taking the character somewhere (`driving`). */
  drive(on: boolean): void;
  /** Sent to the console, as every module's notices are. */
  notice(message: string): void;
  /** The view moved: the window is sent it, once the sessions are all made. */
  changed(): void;
}

/** What the session hands the extensions as a whole. */
export interface ExtensionSessionParts {
  /** Configures the session again, so a layer lands. */
  relayer(): void;
  notice(message: string): void;
  /** The automation snapshot changed: the window is sent it. */
  changed(): void;
}

interface Running {
  extension: LoadedExtension;
  session: ExtensionSession;
  writes: readonly LayerWrite[];
  driving: boolean;
  /** The hooks whose failure has been said, so a hook failing every line is said once. */
  said: Set<string>;
}

export class SessionExtensions implements SessionModule {
  private readonly running: Running[] = [];
  /**
   * A layer laid, or a view moved, while the sessions are being made waits for
   * the session's first configure and publish.
   */
  private ready = false;

  constructor(
    extensions: readonly LoadedExtension[],
    host: (extension: LoadedExtension, kit: ExtensionHostKit) => ExtensionSessionHost,
    private readonly parts: ExtensionSessionParts
  ) {
    for (const extension of extensions) {
      const entry: Running = {
        extension,
        session: { view: () => null },
        writes: [],
        driving: false,
        said: new Set()
      };
      const kit: ExtensionHostKit = {
        layer: (writes) => {
          entry.writes = writes ?? [];
          if (this.ready) this.parts.relayer();
        },
        drive: (on) => {
          entry.driving = on;
        },
        notice: (message) => this.parts.notice(message),
        changed: () => {
          if (this.ready) this.parts.changed();
        }
      };
      const session = this.guard(entry, 'session', () =>
        extension.module.session(host(extension, kit))
      );
      if (session === undefined) continue;
      entry.session = session;
      this.running.push(entry);
    }
    this.ready = true;
  }

  /**
   * Whether an extension is taking this character somewhere: scripting it,
   * standing still between steps included, so the character runs from a
   * fight at the run setting as on any walk (`Travel.goingSomewhere`).
   */
  get driving(): boolean {
    return this.running.some((entry) => entry.driving);
  }

  /** The character's own settings with every extension's laid over them, in folder order. */
  over(own: AutomationConfig): AutomationConfig {
    return withLayer(
      own,
      this.running.flatMap((entry) => entry.writes)
    );
  }

  configure(config: AutomationConfig): void {
    for (const entry of this.running)
      this.guard(entry, 'configure', () => entry.session.configure?.(config));
  }

  onBlock(block: Block): void {
    for (const entry of this.running)
      this.guard(entry, 'onBlock', () => entry.session.onBlock?.(block));
  }

  onCharacter(state: CharacterState): void {
    for (const entry of this.running) {
      this.guard(entry, 'onCharacter', () => entry.session.onCharacter?.(state));
    }
  }

  playerStopped(): void {
    for (const entry of this.running)
      this.guard(entry, 'playerStopped', () => entry.session.playerStopped?.());
  }

  reset(): void {
    for (const entry of this.running) this.guard(entry, 'reset', () => entry.session.reset?.());
  }

  dispose(): void {
    for (const entry of this.running) this.guard(entry, 'dispose', () => entry.session.dispose?.());
  }

  /** Each extension's card view, by name. */
  views(): Record<string, unknown> {
    const views: Record<string, unknown> = {};
    for (const entry of this.running) {
      views[entry.extension.manifest.name] =
        this.guard(entry, 'view', () => entry.session.view()) ?? null;
    }
    return views;
  }

  /** One of a card's buttons: what the extension answers, or why nothing could. */
  async action(
    name: string,
    action: string,
    args: readonly unknown[]
  ): Promise<{ value: unknown } | { refusal: string }> {
    const entry = this.running.find((each) => each.extension.manifest.name === name);
    if (entry?.session.action === undefined) {
      return { refusal: t('extensions.noAction', { name, action }) };
    }
    try {
      return { value: await entry.session.action(action, args) };
    } catch (error) {
      return {
        refusal: t('extensions.failed', { name, hook: action, error: errorMessage(error) })
      };
    }
  }

  private guard<T>(entry: Running, hook: string, call: () => T): T | undefined {
    try {
      const value = call();
      entry.said.delete(hook);
      return value;
    } catch (error) {
      if (!entry.said.has(hook)) {
        entry.said.add(hook);
        this.parts.notice(
          t('extensions.failed', {
            name: entry.extension.manifest.name,
            hook,
            error: errorMessage(error)
          })
        );
      }
      return undefined;
    }
  }
}
