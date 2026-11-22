/**
 * The command capsule: chips above, a field and a send button. On the Chat tab
 * the chips are the talk channels and the field's line is composed for the
 * chosen one (`compose`, so a line that already names a channel is sent as
 * typed); elsewhere they are commands that send at once. The dock owns its
 * draft, so a keystroke redraws this and nothing else.
 */
import { memo, useCallback, useState, type FormEvent } from 'react';

import { compose, TALK_CHANNELS, talkChannel, type TalkChannel } from '@shared/talk';
import { t } from '../../lib/i18n';
import { PHONE_CHIPS } from '../../lib/phone';

export interface PhoneDockProps {
  /** One command line, without its carriage return. */
  send(line: string): void;
  talking: boolean;
}

function PhoneDock({ send, talking }: PhoneDockProps) {
  const [draft, setDraft] = useState('');
  const [channel, setChannel] = useState<TalkChannel>(() => talkChannel(null));
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (talking) {
        const said = compose(draft, channel);
        if (said === null) return;
        if (said.command !== null) send(said.command);
        setChannel(said.channel);
      } else send(draft);
      setDraft('');
    },
    [talking, draft, channel, send]
  );
  return (
    <form className="phone-dock" onSubmit={submit}>
      <div className="phone-chips" role="group" aria-label={t('phone.dock.chipsAria')}>
        {talking
          ? TALK_CHANNELS.map((one) => (
              <button
                aria-pressed={one.word === channel.word}
                key={one.word}
                // Not blur-then-click: a chip tapped must not close the keyboard.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setChannel(one)}
                type="button"
              >
                {one.label}
              </button>
            ))
          : PHONE_CHIPS.map((chip) => (
              <button
                key={chip}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => send(chip)}
                type="button"
              >
                {chip}
              </button>
            ))}
      </div>
      <div className="phone-capsule phone-glass">
        <input
          aria-label={t('phone.dock.fieldAria')}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="send"
          onChange={(event) => setDraft(event.target.value)}
          placeholder={talking ? channel.label : t('phone.dock.placeholder')}
          spellCheck={false}
          value={draft}
        />
        <button aria-label={t('phone.dock.send')} className="phone-send" type="submit">
          ➤
        </button>
      </div>
    </form>
  );
}

export default memo(PhoneDock);
