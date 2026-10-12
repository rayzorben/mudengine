/**
 * A browser tab's link to the client, kept across the sockets that carry it:
 * the other half of `main/host/web/tabs.ts`. Requests go out numbered and
 * held until taken; messages in are taken once and acknowledged. A dropped
 * socket is dialled again, says hello as this tab and is sent what it
 * missed, so nothing is redrawn; only a client that no longer knows the tab
 * starts the window over (`renewed`). The cover goes up after
 * `webLostCoverMs`; a lost sign-in is asked for in it, never by a reload.
 * See `mudengine-session` › *A browser tab outlives its socket*.
 */
import {
  asRpcFrame,
  GAVE_UP,
  PAGE_CLOSED,
  RPC_PATH,
  type RpcHello,
  type RpcInvoke,
  type RpcOutbound,
  type RpcSend,
  type RpcWelcome
} from '@shared/rpc';

import { BUILD, buildId } from '@shared/build';
import { t } from './i18n';
import { PushPatches } from './patches';
import { readStored, writeStored } from './storage';
import { TabHealth } from './tabHealth';
import { tuning } from './tuning';

/** A request before the link numbers it. */
export type Unnumbered = Omit<RpcSend, 'q'> | Omit<RpcInvoke, 'q'>;

export interface WebLinkEvents {
  /** A push or a reply, each once and in order. */
  frame(message: RpcOutbound): void;
  /** The client no longer knows this tab: what it was owed is gone, and the window starts over. */
  renewed(): void;
}

export interface WebLink {
  /**
   * `perishable` is a key: sent after the link is back only if it is younger
   * than `webLostCoverMs`, since keys typed into a link that died unnoticed
   * would otherwise arrive as a burst of moves.
   */
  send(request: Unnumbered, perishable?: boolean): void;
  /** The window is covered: the link has been down past `webLostCoverMs`. */
  readonly covered: boolean;
}

/** The client build this tab last reloaded to reach (`welcome`). */
const RELOADED_FOR = 'mudengine.reloadedFor';

/** The client refused something this tab sent: malformed (1007) or too large (1009). */
const REFUSED = new Set([1007, 1009]);

export function openWebLink(events: WebLinkEvents, signal: AbortSignal): WebLink {
  let socket: WebSocket | null = null;
  /** Who the client knows this tab as, once welcomed. */
  let tab: number | null = null;
  let key: string | null = null;
  /** The last message taken, and the last the client was told of. */
  let last = 0;
  let acked = 0;
  /** The last request numbered, and those the client has not said it has. */
  let numbered = 0;
  /** `madeAt` is set on a key, which goes stale (`send`). */
  let held: { q: number; text: string; madeAt: number | null }[] = [];
  /** The client closed on a request it refused; the welcome says which. */
  let refused = false;
  /** Welcomed on the socket in hand. */
  let linked = false;
  let welcomedOnce = false;
  let down = false;
  let covered = false;
  let cover: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let heardAt = 0;
  let quietFor: number | null = null;
  const health = new TabHealth(signal);
  const patches = new PushPatches();

  const url = (): string => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}${RPC_PATH}`;
  };

  const release = (got: number): void => {
    const keep = held.findIndex((entry) => entry.q > got);
    held = keep === -1 ? [] : held.slice(keep);
  };

  const send = (request: Unnumbered, perishable = false): void => {
    numbered += 1;
    const text = JSON.stringify({ ...request, q: numbered });
    held.push({ q: numbered, text, madeAt: perishable ? Date.now() : null });
    if (linked && socket?.readyState === WebSocket.OPEN) socket.send(text);
  };

  /** The link went down: dial at once, and cover the window if it stays down. */
  const lost = (): void => {
    linked = false;
    health.down();
    quietFor = null;
    if (!down) {
      down = true;
      cover = setTimeout(() => {
        covered = true;
        showCover(t('web.link.lost'));
      }, tuning().webLostCoverMs);
    }
    connect();
  };

  const back = (): void => {
    if (cover !== null) clearTimeout(cover);
    cover = null;
    covered = false;
    down = false;
    hideCover();
  };

  /**
   * A dial that never got as far as a welcome. A refused upgrade looks the
   * same as a dead network from here, so the page itself is asked for: a 401
   * is a sign-in the client no longer holds (it keeps them in memory, so a
   * restart drops every one).
   */
  const dialLater = (): void => {
    if (retry !== null || signal.aborted) return;
    const again = (): void => {
      if (signal.aborted) return;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, tuning().webReconnectMs);
    };
    fetch('/', { method: 'HEAD', cache: 'no-store' })
      .then((response) => {
        if (response.status === 401) askToSignIn();
        else again();
      })
      .catch(again);
  };

  /** The password, asked in the cover; signed in, the tab dials again. */
  const askToSignIn = (): void => {
    if (cover !== null) clearTimeout(cover);
    cover = null;
    covered = true;
    showSignIn(async (password) => {
      const response = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password }).toString(),
        redirect: 'manual',
        cache: 'no-store'
      });
      // The sign-in answers with a redirect home, which `manual` leaves unread.
      const signedIn = response.type === 'opaqueredirect' || response.ok;
      if (signedIn) {
        showCover(t('web.link.lost'));
        connect();
      }
      return signedIn;
    });
  };

  /** Dial now rather than at the next try: the browser says the way is open. */
  const dialNow = (): void => {
    if (retry === null) return;
    clearTimeout(retry);
    retry = null;
    connect();
  };

  /**
   * Each tick: tell the client what has been taken, and give up a socket
   * that has heard nothing for two beats, however open it looks. It is
   * dialled again before it is closed, since its close can wait on a
   * handshake the dead link will never carry.
   */
  const tick = (): void => {
    const live = socket;
    if (!linked || live === null) return;
    if (quietFor !== null && Date.now() - heardAt > quietFor) {
      lost();
      live.close(GAVE_UP);
      return;
    }
    if (last > acked && live.readyState === WebSocket.OPEN) {
      live.send(JSON.stringify({ k: 'ack', n: last }));
      acked = last;
    }
  };

  const welcome = (ws: WebSocket, frame: RpcWelcome): void => {
    /*
     * The client restarted onto another build, and this page holds the old
     * one's code, which cannot read what the new one sends (2026-10-11: a
     * page from before patches ignored every character push and froze on
     * the login). Only a reload brings in the new code. Once per build: a
     * page that comes back still behind (the files served are not the build
     * running) says so rather than reloading round and round.
     */
    const own = buildId(BUILD);
    if (frame.build !== null && own !== null && frame.build !== own) {
      if (
        readStored(
          RELOADED_FOR,
          (stored) => stored,
          () => '',
          'session'
        ) === frame.build
      ) {
        showCover(t('web.link.updateStuck'));
        return;
      }
      writeStored(RELOADED_FOR, frame.build, 'session');
      showCover(t('web.link.updated'));
      location.reload();
      return;
    }
    const returning = welcomedOnce;
    const renewed = !frame.resumed && returning;
    tab = frame.tab;
    key = frame.key;
    if (!frame.resumed) {
      last = 0;
      acked = 0;
      patches.clear();
    }
    // A new window owes nothing the old one asked: the remount asks again.
    if (renewed) held = [];
    else release(frame.got);
    // Requests arrive in order, so the one refused is the first not taken.
    // Sent again it would be refused again, round and round.
    if (refused) held = held.slice(1);
    refused = false;
    const fresh = Date.now() - tuning().webLostCoverMs;
    held = held.filter((entry) => entry.madeAt === null || entry.madeAt >= fresh);
    linked = true;
    welcomedOnce = true;
    for (const entry of held) ws.send(entry.text);
    if (returning) health.up(frame.resumed);
    back();
    if (renewed) events.renewed();
  };

  const connect = (): void => {
    if (signal.aborted) return;
    const ws = new WebSocket(url());
    socket = ws;
    linked = false;
    /*
     * A dial made while the network is still coming up can sit connecting
     * with no end the browser enforces; past the deadline it is given up and
     * the next one made, as a refused one is.
     */
    const deadline = setTimeout(() => {
      if (linked || socket !== ws) return;
      ws.onclose = null;
      ws.close(GAVE_UP);
      dialLater();
    }, tuning().webDialMs);
    ws.onopen = () => {
      heardAt = Date.now();
      const hello: RpcHello = { k: 'hello', tab, key, last };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (event) => {
      // A socket already replaced: what it carries is sent again on the new one.
      if (socket !== ws) return;
      heardAt = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const frame = asRpcFrame(parsed);
      if (frame === null) return;
      switch (frame.k) {
        case 'welcome':
          clearTimeout(deadline);
          welcome(ws, frame);
          return;
        case 'beat':
          quietFor = 2 * frame.next;
          release(frame.got);
          return;
        case 'push':
        case 'reply':
        case 'patch': {
          if (!linked || frame.n <= last) return;
          last = frame.n;
          health.frame(String(event.data).length);
          const { n: _taken, ...message } = frame;
          events.frame(message.k === 'patch' ? patches.apply(message) : message);
          return;
        }
        default: {
          const unreachable: never = frame;
          return unreachable;
        }
      }
    };
    ws.onclose = (event) => {
      clearTimeout(deadline);
      health.closed(event.code);
      if (socket !== ws || signal.aborted) return;
      if (REFUSED.has(event.code)) refused = true;
      if (linked) lost();
      else dialLater();
    };
    ws.onerror = () => ws.close();
  };

  connect();
  const ticking = setInterval(tick, tuning().webReconnectMs);
  // What the player felt, for `logs/web.log`: sent once linked, kept otherwise.
  const reporting = setInterval(() => {
    if (!linked || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ k: 'report', ...health.take() }));
  }, tuning().webReportMs);
  window.addEventListener('online', dialNow, { signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState !== 'visible') return;
      // What arrived while the tab was paused is read first, then judged.
      setTimeout(tick, 0);
      dialNow();
    },
    { signal }
  );
  signal.addEventListener('abort', () => {
    clearInterval(ticking);
    clearInterval(reporting);
    if (cover !== null) clearTimeout(cover);
    if (retry !== null) clearTimeout(retry);
    socket?.close(PAGE_CLOSED);
  });
  // A tab closed is gone, where a tab dropped comes back; a page kept for the
  // back button (`persisted`) may come back too.
  window.addEventListener(
    'pagehide',
    (event) => {
      if (!event.persisted) socket?.close(PAGE_CLOSED);
    },
    { signal }
  );

  return {
    send,
    get covered() {
      return covered;
    }
  };
}

const COVER_ID = 'link-lost';

/**
 * The cover, with one sentence. Outside React on purpose: the link is what
 * knows the socket is gone, and it opens before React mounts. `.link-lost`
 * is styled in `index.css` from the same tokens as everything else.
 */
function coverPanel(): HTMLDivElement {
  let cover = document.getElementById(COVER_ID);
  if (cover === null) {
    cover = document.createElement('div');
    cover.id = COVER_ID;
    cover.className = 'link-lost';
    cover.setAttribute('role', 'alert');
    document.body.appendChild(cover);
  }
  const panel = document.createElement('div');
  panel.className = 'link-lost-panel';
  cover.replaceChildren(panel);
  return panel;
}

function showCover(message: string): void {
  coverPanel().textContent = message;
}

function hideCover(): void {
  document.getElementById(COVER_ID)?.remove();
}

/** The password field in the cover; `submit` answers whether it signed in. */
function showSignIn(submit: (password: string) => Promise<boolean>): void {
  const panel = coverPanel();
  const form = document.createElement('form');
  form.className = 'link-sign-in';
  const said = document.createElement('p');
  said.textContent = t('web.link.signIn');
  const field = document.createElement('input');
  field.type = 'password';
  field.autocomplete = 'current-password';
  field.setAttribute('aria-label', t('web.link.password'));
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = t('web.link.signInButton');
  const wrong = document.createElement('p');
  wrong.className = 'link-sign-in-wrong';
  form.append(said, field, button, wrong);
  panel.replaceChildren(form);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    button.disabled = true;
    wrong.textContent = '';
    submit(field.value)
      .then((signedIn) => {
        if (!signedIn) wrong.textContent = t('web.link.wrongPassword');
      })
      .catch(() => {
        wrong.textContent = t('web.link.lost');
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  field.focus();
}
