/**
 * A complete, socket-free Telnet stream parser.
 *
 * Every prior attempt in this workspace piped raw socket bytes straight into a
 * terminal, so IAC framing was rendered as CP437 glyphs and negotiations went
 * unanswered. This class fixes that: it consumes arbitrary byte chunks, splits
 * protocol from payload, answers option negotiation using the RFC 1143 "Q
 * method" state machine (which is loop-free by construction), and hands back
 * clean application data.
 *
 * It holds no I/O and no timers, so it is directly unit-testable.
 */
import { CMD, OPT, SUB, commandName, optionName } from './telnet-constants';
import type { TelnetEvent, TerminalSize } from '../../shared/types';

/** RFC 1143 per-option negotiation state. */
enum QState {
  No,
  Yes,
  WantNo,
  WantYes
}

interface OptionState {
  /** Whether *we* are performing the option. */
  us: QState;
  /** Whether the *peer* is performing the option. */
  him: QState;
}

/** Parser state machine positions. */
enum Mode {
  Data,
  Iac,
  /** Awaiting the option byte after WILL/WONT/DO/DONT. */
  Negotiate,
  /** Awaiting the option byte after SB. */
  SubOption,
  /** Collecting subnegotiation payload. */
  SubData,
  /** Saw IAC inside subnegotiation payload. */
  SubIac
}

export interface TelnetParserOptions {
  /**
   * Terminal types offered in response to TERMINAL-TYPE SEND, in preference
   * order. Convention is to cycle and then repeat the last entry to signal the
   * end of the list.
   */
  terminalTypes?: string[];
  /** Charset advertised in a CHARSET negotiation. */
  charset?: string;
  /** Current terminal geometry, read whenever NAWS must be reported. */
  getWindowSize?: () => TerminalSize;
}

export interface TelnetParseResult {
  /** Payload bytes with all framing removed and `IAC IAC` unescaped to `0xFF`. */
  data: Buffer;
  /** Bytes that must be written straight back to the peer. Empty if none. */
  reply: Buffer;
  /** Protocol activity, for the diagnostics pane. */
  events: TelnetEvent[];
  /**
   * Byte offsets into `data` at which the server signalled the end of a prompt
   * (GA or EOR). MajorMUD does not normally use these, but GreaterMUD and
   * Paradigm derivatives can, and they are the only reliable prompt delimiter
   * when a server sends one.
   */
  promptMarks: number[];
}

/** Options we are willing to perform ourselves when the peer sends DO. */
const WE_WILL = new Set<number>([
  OPT.TERMINAL_TYPE,
  OPT.NAWS,
  OPT.TERMINAL_SPEED,
  OPT.CHARSET,
  OPT.BINARY,
  OPT.SUPPRESS_GO_AHEAD
]);

/** Options we are willing to let the peer perform when it sends WILL. */
const WE_DO = new Set<number>([
  OPT.SUPPRESS_GO_AHEAD,
  OPT.ECHO,
  OPT.BINARY,
  OPT.END_OF_RECORD,
  OPT.MSSP
]);

export class TelnetParser {
  private mode: Mode = Mode.Data;
  /** The pending WILL/WONT/DO/DONT command awaiting its option byte. */
  private pendingCommand = 0;
  /** Option code of the subnegotiation currently being collected. */
  private subOption = 0;
  private subBuffer: number[] = [];

  private readonly options = new Map<number, OptionState>();

  private readonly terminalTypes: string[];
  private terminalTypeIndex = 0;
  private readonly charset: string;
  private readonly getWindowSize: (() => TerminalSize) | undefined;

  /** Scratch buffers reused across `receive` calls to limit allocation churn. */
  private readonly out: number[] = [];
  private readonly reply: number[] = [];

  constructor(opts: TelnetParserOptions = {}) {
    this.terminalTypes = opts.terminalTypes ?? ['ANSI', 'XTERM-256COLOR', 'UNKNOWN'];
    this.charset = opts.charset ?? 'CP437';
    this.getWindowSize = opts.getWindowSize;
  }

  /** True once the peer has agreed to suppress go-ahead. */
  get suppressGoAhead(): boolean {
    return this.state(OPT.SUPPRESS_GO_AHEAD).him === QState.Yes;
  }

  /** True while the peer is echoing (password prompts toggle this off). */
  get remoteEcho(): boolean {
    return this.state(OPT.ECHO).him === QState.Yes;
  }

  /** True once either direction has negotiated 8-bit binary transmission. */
  get binary(): boolean {
    const s = this.state(OPT.BINARY);
    return s.us === QState.Yes || s.him === QState.Yes;
  }

  /** Options we are currently performing, by name. */
  get localEnabled(): string[] {
    return this.enabled((s) => s.us === QState.Yes);
  }

  /** Options the peer is currently performing, by name. */
  get remoteEnabled(): string[] {
    return this.enabled((s) => s.him === QState.Yes);
  }

  /**
   * Feed a chunk of socket bytes through the state machine.
   *
   * Partial sequences are retained across calls, so callers may pass whatever
   * arbitrary fragments the kernel hands them.
   */
  receive(chunk: Buffer): TelnetParseResult {
    this.out.length = 0;
    this.reply.length = 0;
    const events: TelnetEvent[] = [];
    const promptMarks: number[] = [];

    for (const byte of chunk) {
      switch (this.mode) {
        case Mode.Data:
          if (byte === CMD.IAC) this.mode = Mode.Iac;
          else this.out.push(byte);
          break;

        case Mode.Iac:
          this.handleIac(byte, events, promptMarks);
          break;

        case Mode.Negotiate:
          this.handleNegotiation(this.pendingCommand, byte, events);
          this.mode = Mode.Data;
          break;

        case Mode.SubOption:
          this.subOption = byte;
          this.subBuffer.length = 0;
          this.mode = Mode.SubData;
          break;

        case Mode.SubData:
          if (byte === CMD.IAC) this.mode = Mode.SubIac;
          else this.subBuffer.push(byte);
          break;

        case Mode.SubIac:
          if (byte === CMD.IAC) {
            // Escaped 0xFF inside subnegotiation payload.
            this.subBuffer.push(CMD.IAC);
            this.mode = Mode.SubData;
          } else if (byte === CMD.SE) {
            this.handleSubnegotiation(events);
            this.mode = Mode.Data;
          } else {
            // Malformed: an unescaped IAC followed by something other than SE.
            // Abandon the subnegotiation rather than desynchronising the stream.
            events.push(
              this.event('in', `SB ${optionName(this.subOption)} aborted by ${commandName(byte)}`)
            );
            this.mode = Mode.Data;
          }
          break;
      }
    }

    return {
      data: Buffer.from(this.out),
      reply: this.reply.length > 0 ? Buffer.from(this.reply) : Buffer.alloc(0),
      events,
      promptMarks
    };
  }

  /**
   * Escape application data for transmission.
   *
   * A literal 0xFF byte must be doubled, otherwise the peer reads it as IAC.
   * Outside binary mode RFC 854 also requires a bare CR to be followed by NUL
   * so it cannot be mistaken for a line terminator.
   */
  encode(text: string, encoding: BufferEncoding = 'latin1'): Buffer {
    const raw = Buffer.from(text, encoding);
    const bytes: number[] = [];
    const binary = this.binary;

    for (let i = 0; i < raw.length; i += 1) {
      const byte = raw[i]!;
      if (byte === CMD.IAC) {
        bytes.push(CMD.IAC, CMD.IAC);
        continue;
      }
      bytes.push(byte);
      if (!binary && byte === 0x0d) {
        const next = raw[i + 1];
        if (next !== 0x0a) bytes.push(0x00);
      }
    }

    return Buffer.from(bytes);
  }

  /**
   * Build an unsolicited NAWS report. Returns an empty buffer unless the peer
   * has actually asked us to perform NAWS, so callers can invoke it on every
   * resize without guarding.
   */
  windowSizeReport(size: TerminalSize): Buffer {
    if (this.state(OPT.NAWS).us !== QState.Yes) return Buffer.alloc(0);
    return Buffer.from(this.nawsPayload(size));
  }

  // ---------------------------------------------------------------- internals

  private handleIac(byte: number, events: TelnetEvent[], promptMarks: number[]): void {
    switch (byte) {
      case CMD.IAC:
        // Escaped 0xFF in the data stream.
        this.out.push(CMD.IAC);
        this.mode = Mode.Data;
        break;

      case CMD.WILL:
      case CMD.WONT:
      case CMD.DO:
      case CMD.DONT:
        this.pendingCommand = byte;
        this.mode = Mode.Negotiate;
        break;

      case CMD.SB:
        this.mode = Mode.SubOption;
        break;

      case CMD.GA:
      case CMD.EOR:
        promptMarks.push(this.out.length);
        events.push(this.event('in', commandName(byte)));
        this.mode = Mode.Data;
        break;

      case CMD.NOP:
        this.mode = Mode.Data;
        break;

      case CMD.AYT:
        // "Are You There" expects visible evidence of life.
        this.pushReply([...Buffer.from('\r\n[mudengine: present]\r\n', 'latin1')]);
        events.push(this.event('in', 'AYT'));
        this.mode = Mode.Data;
        break;

      default:
        events.push(this.event('in', commandName(byte)));
        this.mode = Mode.Data;
        break;
    }
  }

  private handleNegotiation(command: number, option: number, events: TelnetEvent[]): void {
    const state = this.state(option);
    events.push(this.event('in', `${commandName(command)} ${optionName(option)}`));

    switch (command) {
      case CMD.WILL:
        if (state.him === QState.No) {
          if (WE_DO.has(option)) {
            state.him = QState.Yes;
            this.sendNegotiation(CMD.DO, option, events);
            this.onRemoteEnabled(option, events);
          } else {
            this.sendNegotiation(CMD.DONT, option, events);
          }
        } else if (state.him === QState.WantNo) {
          state.him = QState.No;
        } else if (state.him === QState.WantYes) {
          state.him = QState.Yes;
          this.onRemoteEnabled(option, events);
        }
        break;

      case CMD.WONT:
        if (state.him === QState.Yes) {
          state.him = QState.No;
          this.sendNegotiation(CMD.DONT, option, events);
        } else {
          state.him = QState.No;
        }
        break;

      case CMD.DO:
        if (state.us === QState.No) {
          if (WE_WILL.has(option)) {
            state.us = QState.Yes;
            this.sendNegotiation(CMD.WILL, option, events);
            this.onLocalEnabled(option, events);
          } else {
            this.sendNegotiation(CMD.WONT, option, events);
          }
        } else if (state.us === QState.WantNo) {
          state.us = QState.No;
        } else if (state.us === QState.WantYes) {
          state.us = QState.Yes;
          this.onLocalEnabled(option, events);
        }
        break;

      case CMD.DONT:
        if (state.us === QState.Yes) {
          state.us = QState.No;
          this.sendNegotiation(CMD.WONT, option, events);
        } else {
          state.us = QState.No;
        }
        break;
    }
  }

  /** Side effects that fire the moment we agree to perform an option. */
  private onLocalEnabled(option: number, events: TelnetEvent[]): void {
    if (option === OPT.NAWS && this.getWindowSize) {
      const payload = this.nawsPayload(this.getWindowSize());
      this.pushReply(payload);
      const size = this.getWindowSize();
      events.push(this.event('out', `SB NAWS ${size.cols}x${size.rows} SE`));
    }
  }

  /** Side effects that fire the moment the peer starts performing an option. */
  private onRemoteEnabled(_option: number, _events: TelnetEvent[]): void {
    // Reserved for MCCP2 / MSSP handling once those are supported.
  }

  private handleSubnegotiation(events: TelnetEvent[]): void {
    const payload = this.subBuffer;
    const kind = payload[0];

    switch (this.subOption) {
      case OPT.TERMINAL_TYPE:
        if (kind === SUB.SEND) {
          const name = this.nextTerminalType();
          const bytes = [
            CMD.IAC,
            CMD.SB,
            OPT.TERMINAL_TYPE,
            SUB.IS,
            ...Buffer.from(name, 'latin1'),
            CMD.IAC,
            CMD.SE
          ];
          this.pushReply(bytes);
          events.push(this.event('in', 'SB TERMINAL-TYPE SEND SE'));
          events.push(this.event('out', `SB TERMINAL-TYPE IS ${name} SE`));
        }
        break;

      case OPT.TERMINAL_SPEED:
        if (kind === SUB.SEND) {
          const bytes = [
            CMD.IAC,
            CMD.SB,
            OPT.TERMINAL_SPEED,
            SUB.IS,
            ...Buffer.from('38400,38400', 'latin1'),
            CMD.IAC,
            CMD.SE
          ];
          this.pushReply(bytes);
          events.push(this.event('out', 'SB TERMINAL-SPEED IS 38400,38400 SE'));
        }
        break;

      case OPT.CHARSET:
        this.handleCharset(payload, events);
        break;

      default:
        events.push(
          this.event('in', `SB ${optionName(this.subOption)} (${payload.length} bytes) SE`)
        );
        break;
    }
  }

  /**
   * RFC 2066 CHARSET. The request payload is `REQUEST <sep> name <sep> name…`.
   * We accept our configured charset if the server offers it, otherwise reject
   * rather than silently agreeing to an encoding we would then mis-decode.
   */
  private handleCharset(payload: number[], events: TelnetEvent[]): void {
    // 1 == REQUEST in the CHARSET sub-namespace.
    if (payload[0] !== 1 || payload.length < 3) return;

    const separator = payload[1]!;
    const list = Buffer.from(payload.slice(2))
      .toString('latin1')
      .split(String.fromCharCode(separator))
      .filter(Boolean);

    events.push(this.event('in', `SB CHARSET REQUEST ${list.join(' ')} SE`));

    const match = list.find((name) => name.toUpperCase() === this.charset.toUpperCase());

    if (match) {
      this.pushReply([
        CMD.IAC,
        CMD.SB,
        OPT.CHARSET,
        SUB.ACCEPTED,
        ...Buffer.from(match, 'latin1'),
        CMD.IAC,
        CMD.SE
      ]);
      events.push(this.event('out', `SB CHARSET ACCEPTED ${match} SE`));
    } else {
      this.pushReply([CMD.IAC, CMD.SB, OPT.CHARSET, SUB.REJECTED, CMD.IAC, CMD.SE]);
      events.push(this.event('out', 'SB CHARSET REJECTED SE'));
    }
  }

  private nawsPayload(size: TerminalSize): number[] {
    const cols = Math.max(1, Math.min(0xffff, Math.round(size.cols)));
    const rows = Math.max(1, Math.min(0xffff, Math.round(size.rows)));
    const bytes: number[] = [CMD.IAC, CMD.SB, OPT.NAWS];

    // Each dimension is a 16-bit big-endian value, and 0xFF must be escaped
    // even here — a 255-column terminal is otherwise unrepresentable.
    for (const value of [cols >> 8, cols & 0xff, rows >> 8, rows & 0xff]) {
      bytes.push(value);
      if (value === CMD.IAC) bytes.push(CMD.IAC);
    }

    bytes.push(CMD.IAC, CMD.SE);
    return bytes;
  }

  private nextTerminalType(): string {
    const list = this.terminalTypes;
    const index = Math.min(this.terminalTypeIndex, list.length - 1);
    // Repeat the final entry once the list is exhausted; that is how a client
    // signals "no more types" to a server that keeps asking.
    if (this.terminalTypeIndex < list.length) this.terminalTypeIndex += 1;
    return list[index] ?? 'UNKNOWN';
  }

  private sendNegotiation(command: number, option: number, events: TelnetEvent[]): void {
    this.pushReply([CMD.IAC, command, option]);
    events.push(this.event('out', `${commandName(command)} ${optionName(option)}`));
  }

  private pushReply(bytes: number[]): void {
    for (const byte of bytes) this.reply.push(byte);
  }

  private state(option: number): OptionState {
    let entry = this.options.get(option);
    if (!entry) {
      entry = { us: QState.No, him: QState.No };
      this.options.set(option, entry);
    }
    return entry;
  }

  private enabled(predicate: (s: OptionState) => boolean): string[] {
    const names: string[] = [];
    for (const [option, state] of this.options) {
      if (predicate(state)) names.push(optionName(option));
    }
    return names.sort();
  }

  private event(direction: 'in' | 'out', summary: string): TelnetEvent {
    return { at: Date.now(), direction, summary };
  }
}
