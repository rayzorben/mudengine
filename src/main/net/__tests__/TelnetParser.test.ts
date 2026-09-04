import { describe, expect, it } from 'vitest';

import { TelnetParser } from '../TelnetParser';
import { CMD, OPT, SUB } from '../telnet-constants';

const IAC = CMD.IAC;

function parser(): TelnetParser {
  return new TelnetParser({
    terminalTypes: ['ANSI', 'XTERM-256COLOR'],
    charset: 'CP437',
    getWindowSize: () => ({ cols: 80, rows: 24 })
  });
}

describe('TelnetParser data extraction', () => {
  it('passes plain data through untouched', () => {
    const result = parser().receive(Buffer.from('Obvious exits: north, south\r\n', 'latin1'));
    expect(result.data.toString('latin1')).toBe('Obvious exits: north, south\r\n');
    expect(result.reply).toHaveLength(0);
  });

  it('unescapes IAC IAC to a single 0xFF data byte', () => {
    const result = parser().receive(Buffer.from([0x41, IAC, IAC, 0x42]));
    expect([...result.data]).toEqual([0x41, 0xff, 0x42]);
  });

  it('strips negotiation from the middle of a data run', () => {
    const result = parser().receive(
      Buffer.from([0x48, 0x50, IAC, CMD.WILL, OPT.SUPPRESS_GO_AHEAD, 0x3d, 0x39])
    );
    expect(result.data.toString('latin1')).toBe('HP=9');
  });

  it('reassembles a command split across chunk boundaries', () => {
    const p = parser();
    const first = p.receive(Buffer.from([0x41, IAC]));
    const second = p.receive(Buffer.from([CMD.WILL]));
    const third = p.receive(Buffer.from([OPT.SUPPRESS_GO_AHEAD, 0x42]));

    expect(first.data.toString('latin1')).toBe('A');
    expect(second.data).toHaveLength(0);
    expect(third.data.toString('latin1')).toBe('B');
    expect([...third.reply]).toEqual([IAC, CMD.DO, OPT.SUPPRESS_GO_AHEAD]);
  });

  it('records GA and EOR as prompt marks at the right data offset', () => {
    const result = parser().receive(
      Buffer.from([...Buffer.from('[HP=99]:', 'latin1'), IAC, CMD.GA, 0x78])
    );
    expect(result.promptMarks).toEqual([8]);
    expect(result.data.toString('latin1')).toBe('[HP=99]:x');
  });

  it('ignores NOP without disturbing the stream', () => {
    const result = parser().receive(Buffer.from([0x41, IAC, CMD.NOP, 0x42]));
    expect(result.data.toString('latin1')).toBe('AB');
  });
});

describe('TelnetParser option negotiation', () => {
  it('accepts options it wants and refuses the rest', () => {
    const p = parser();
    const accept = p.receive(Buffer.from([IAC, CMD.WILL, OPT.ECHO]));
    expect([...accept.reply]).toEqual([IAC, CMD.DO, OPT.ECHO]);
    expect(p.remoteEcho).toBe(true);

    const refuse = p.receive(Buffer.from([IAC, CMD.WILL, OPT.MCCP2]));
    expect([...refuse.reply]).toEqual([IAC, CMD.DONT, OPT.MCCP2]);
  });

  it('answers DO with WILL only for options it can perform', () => {
    const p = parser();
    expect([...p.receive(Buffer.from([IAC, CMD.DO, OPT.TERMINAL_TYPE])).reply]).toEqual([
      IAC,
      CMD.WILL,
      OPT.TERMINAL_TYPE
    ]);
    expect([...p.receive(Buffer.from([IAC, CMD.DO, OPT.LINEMODE])).reply]).toEqual([
      IAC,
      CMD.WONT,
      OPT.LINEMODE
    ]);
  });

  it('does not loop when the peer repeats an agreed negotiation', () => {
    const p = parser();
    p.receive(Buffer.from([IAC, CMD.WILL, OPT.SUPPRESS_GO_AHEAD]));
    const repeat = p.receive(Buffer.from([IAC, CMD.WILL, OPT.SUPPRESS_GO_AHEAD]));
    expect(repeat.reply).toHaveLength(0);
  });

  it('reports NAWS immediately upon agreeing to perform it', () => {
    const p = parser();
    const reply = [...p.receive(Buffer.from([IAC, CMD.DO, OPT.NAWS])).reply];
    expect(reply).toEqual([
      IAC,
      CMD.WILL,
      OPT.NAWS,
      IAC,
      CMD.SB,
      OPT.NAWS,
      0,
      80,
      0,
      24,
      IAC,
      CMD.SE
    ]);
  });

  it('withdraws an option when the peer sends DONT', () => {
    const p = parser();
    p.receive(Buffer.from([IAC, CMD.DO, OPT.NAWS]));
    const withdraw = p.receive(Buffer.from([IAC, CMD.DONT, OPT.NAWS]));
    expect([...withdraw.reply]).toEqual([IAC, CMD.WONT, OPT.NAWS]);
    expect(p.windowSizeReport({ cols: 100, rows: 40 })).toHaveLength(0);
  });
});

describe('TelnetParser subnegotiation', () => {
  it('answers TERMINAL-TYPE SEND and advances through the offered list', () => {
    const p = parser();
    p.receive(Buffer.from([IAC, CMD.DO, OPT.TERMINAL_TYPE]));

    const send = Buffer.from([IAC, CMD.SB, OPT.TERMINAL_TYPE, SUB.SEND, IAC, CMD.SE]);
    const first = p.receive(send).reply.toString('latin1');
    const second = p.receive(send).reply.toString('latin1');
    const third = p.receive(send).reply.toString('latin1');

    expect(first).toContain('ANSI');
    expect(second).toContain('XTERM-256COLOR');
    // The list is exhausted, so the final entry repeats to signal the end.
    expect(third).toContain('XTERM-256COLOR');
  });

  it('accepts a CHARSET offer that includes the configured encoding', () => {
    const p = parser();
    const offer = Buffer.from([
      IAC,
      CMD.SB,
      OPT.CHARSET,
      1, // REQUEST
      0x20, // separator
      ...Buffer.from('UTF-8 CP437', 'latin1'),
      IAC,
      CMD.SE
    ]);
    const reply = p.receive(offer).reply;
    expect(reply[3]).toBe(SUB.ACCEPTED);
    expect(reply.toString('latin1')).toContain('CP437');
  });

  it('rejects a CHARSET offer with no acceptable encoding', () => {
    const p = parser();
    const offer = Buffer.from([
      IAC,
      CMD.SB,
      OPT.CHARSET,
      1,
      0x20,
      ...Buffer.from('BIG5', 'latin1'),
      IAC,
      CMD.SE
    ]);
    expect([...p.receive(offer).reply]).toEqual([
      IAC,
      CMD.SB,
      OPT.CHARSET,
      SUB.REJECTED,
      IAC,
      CMD.SE
    ]);
  });

  it('keeps an escaped 0xFF inside a subnegotiation payload', () => {
    const p = parser();
    // An unknown option, so the payload is only logged — but the parser must
    // still consume it correctly and resume data mode afterwards.
    const chunk = Buffer.from([IAC, CMD.SB, OPT.MSSP, 0x01, IAC, IAC, 0x02, IAC, CMD.SE, 0x5a]);
    const result = p.receive(chunk);
    expect(result.data.toString('latin1')).toBe('Z');
  });

  it('recovers from a malformed subnegotiation rather than desynchronising', () => {
    const p = parser();
    const chunk = Buffer.from([IAC, CMD.SB, OPT.MSSP, 0x01, IAC, CMD.NOP, 0x41, 0x42]);
    const result = p.receive(chunk);
    expect(result.data.toString('latin1')).toBe('AB');
  });
});

describe('TelnetParser outbound encoding', () => {
  it('doubles a literal 0xFF so it is not read as IAC', () => {
    const encoded = parser().encode('a\xffb');
    expect([...encoded]).toEqual([0x61, 0xff, 0xff, 0x62]);
  });

  it('pads a bare CR with NUL per RFC 854 when not in binary mode', () => {
    expect([...parser().encode('n\r')]).toEqual([0x6e, 0x0d, 0x00]);
  });

  it('leaves a CR LF pair alone', () => {
    expect([...parser().encode('n\r\n')]).toEqual([0x6e, 0x0d, 0x0a]);
  });

  it('stops padding CR once binary transmission is negotiated', () => {
    const p = parser();
    p.receive(Buffer.from([IAC, CMD.WILL, OPT.BINARY]));
    expect([...p.encode('n\r')]).toEqual([0x6e, 0x0d]);
  });
});
