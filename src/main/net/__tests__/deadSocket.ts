import { EventEmitter } from 'node:events';

/**
 * A socket that dials and then does nothing, which is what a dropped SYN looks
 * like from here.
 *
 * The real case, a firewall that swallows the handshake or a realm restarting,
 * cannot be produced on demand against the one realm this project dials. So
 * the connector is stubbed rather than the network coerced: the behaviour
 * under test is the client's, not the kernel's. `written` holds what reached
 * it, which a socket that never opened must not be given.
 */
export class DeadSocket extends EventEmitter {
  destroyed = false;
  readonly written: unknown[] = [];
  setNoDelay(): this {
    return this;
  }
  write(chunk: unknown): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): this {
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  override removeListener(event: string, listener: (...args: never[]) => void): this {
    super.removeListener(event, listener as (...args: unknown[]) => void);
    return this;
  }
}
