/**
 * A sound for an alert whose row asks for one (MegaMUD's `[Alerts]`, todo 80).
 *
 * Read from what landed in each character's log (`freshNotices`): one tone
 * per flush however many fresh notices sound, and nothing for a backlog. A
 * short tone from Web Audio, so there is no file to ship.
 */
import { useEffect, useRef } from 'react';

import { freshNotices } from '../lib/freshNotices';
import { tuning } from '../lib/tuning';
import { sounds, type AlertRule, type Notice } from '@shared/notifications';
import type { SessionId } from '@shared/ipc';

export interface SoundSubject {
  /** The character's alerts, oldest first, as `useSessionViews` keeps them. */
  notices: Notice[];
}

export interface AlertSoundsOptions {
  subjects: Readonly<Record<SessionId, SoundSubject>>;
  /** The player's own alert rows; a row with `sound` plays as its alert shows. */
  rules: readonly AlertRule[];
}

export function useAlertSounds({ subjects, rules }: AlertSoundsOptions): void {
  /* The newest notice already accounted for, per character. */
  const seen = useRef(new Map<SessionId, string>());
  /* Made on the first sound, never before: a window with no sounding row opens no audio. */
  const audio = useRef<AudioContext | null>(null);

  useEffect(() => {
    let play = false;
    for (const [id, subject] of Object.entries(subjects) as Array<[SessionId, SoundSubject]>) {
      const fresh = freshNotices(seen.current, id, subject.notices);
      if (fresh?.some((notice) => sounds(notice, rules)) === true) play = true;
    }
    if (play) audio.current = tone(audio.current);
  }, [subjects, rules]);

  useEffect(
    () => () => {
      void audio.current?.close();
    },
    []
  );
}

/** One short tone; the context is made once and kept. */
function tone(had: AudioContext | null): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  const context = had ?? new AudioContext();
  const { alertToneHz, alertToneMs } = tuning();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = alertToneHz;
  const end = context.currentTime + alertToneMs / 1000;
  gain.gain.setValueAtTime(0.2, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, end);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(end);
  return context;
}
