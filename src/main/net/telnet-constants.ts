/**
 * Telnet protocol constants (RFC 854/855 and the option RFCs a MUD actually
 * encounters). Kept as a flat module so the parser stays free of imports.
 */

/** Telnet commands, RFC 854 section "Telnet Command Structure". */
export const CMD = {
  /** Interpret As Command. */
  IAC: 255,
  /** Peer will not perform, or refuses to perform, an option. */
  DONT: 254,
  /** Request that the peer perform an option. */
  DO: 253,
  /** Refusal to perform an option. */
  WONT: 252,
  /** Offer or confirmation to perform an option. */
  WILL: 251,
  /** Begin subnegotiation. */
  SB: 250,
  /** Go Ahead — on a MUD this marks the end of a prompt. */
  GA: 249,
  /** Erase Line. */
  EL: 248,
  /** Erase Character. */
  EC: 247,
  /** Are You There. */
  AYT: 246,
  /** Abort Output. */
  AO: 245,
  /** Interrupt Process. */
  IP: 244,
  /** Break. */
  BRK: 243,
  /** Data Mark. */
  DM: 242,
  /** No Operation. */
  NOP: 241,
  /** End of subnegotiation. */
  SE: 240,
  /** End of Record, RFC 885 — also a prompt marker. */
  EOR: 239
} as const;

/** Telnet options this engine has an opinion about. */
export const OPT = {
  /** RFC 856 — 8-bit clean transmission. */
  BINARY: 0,
  /** RFC 857 — who echoes typed characters. */
  ECHO: 1,
  /** RFC 858 — suppress go-ahead; effectively always on for MUDs. */
  SUPPRESS_GO_AHEAD: 3,
  /** RFC 859 — status. */
  STATUS: 5,
  /** RFC 860 — timing mark. */
  TIMING_MARK: 6,
  /** RFC 1091 — terminal type. */
  TERMINAL_TYPE: 24,
  /** RFC 885 — end of record. */
  END_OF_RECORD: 25,
  /** RFC 1073 — negotiate about window size. */
  NAWS: 31,
  /** RFC 1079 — terminal speed. */
  TERMINAL_SPEED: 32,
  /** RFC 1372 — remote flow control. */
  TOGGLE_FLOW_CONTROL: 33,
  /** RFC 1184 — linemode. */
  LINEMODE: 34,
  /** RFC 1572 — new environment. */
  NEW_ENVIRON: 39,
  /** RFC 2066 — charset negotiation. */
  CHARSET: 42,
  /** MUD Server Status Protocol. */
  MSSP: 70,
  /** MUD Client Compression Protocol v1 (deprecated). */
  MCCP1: 85,
  /** MUD Client Compression Protocol v2. */
  MCCP2: 86,
  /** MUD eXtension Protocol. */
  MXP: 91,
  /** Achaea Telnet Client Protocol. */
  ATCP: 200,
  /** Generic MUD Communication Protocol. */
  GMCP: 201
} as const;

/** Subnegotiation sub-commands shared by TERMINAL-TYPE, CHARSET, NEW-ENVIRON. */
export const SUB = {
  IS: 0,
  SEND: 1,
  /** CHARSET: peer accepted our charset. */
  ACCEPTED: 2,
  /** CHARSET: peer rejected all offered charsets. */
  REJECTED: 3
} as const;

const CMD_NAMES = new Map<number, string>(
  Object.entries(CMD).map(([name, code]) => [code as number, name])
);

const OPT_NAMES = new Map<number, string>(
  Object.entries(OPT).map(([name, code]) => [code as number, name.replace(/_/g, '-')])
);

export function commandName(code: number): string {
  return CMD_NAMES.get(code) ?? `CMD(${code})`;
}

export function optionName(code: number): string {
  return OPT_NAMES.get(code) ?? `OPT(${code})`;
}
