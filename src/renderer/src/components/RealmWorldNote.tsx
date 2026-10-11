/**
 * The world database the realm's characters walk, under its picker (todo 80):
 * where it came from, its own family and version, and a warning when the
 * server's lines name another family. Read off an open session, so a realm
 * with none open says when it will be shown.
 */
import { useEffect, useState } from 'react';

import { t } from '../lib/i18n';
import { familiesDisagree, REALM_FAMILY_LABEL, type RealmWorld } from '@shared/realm';
import { errorMessage } from '@shared/values';

export default function RealmWorldNote({
  host,
  port
}: {
  host: string;
  port: number;
}): React.JSX.Element {
  const [world, setWorld] = useState<RealmWorld | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setWorld(null);
    setProblem(null);
    window.mudengine
      .realmWorld(host, port)
      .then((found) => {
        if (current) setWorld(found);
      })
      .catch((error: unknown) => {
        if (current) setProblem(errorMessage(error));
      });
    return () => {
      current = false;
    };
  }, [host, port]);

  if (problem !== null) return <p className="settings-warn">{problem}</p>;
  if (world === null) return <p className="settings-note">{t('settings.realms.worldUnread')}</p>;
  const family =
    world.family === null ? t('settings.realms.worldNoFamily') : REALM_FAMILY_LABEL[world.family];
  const version = world.build?.data ?? world.build?.custom ?? t('settings.realms.worldNoVersion');
  return (
    <>
      <p className="settings-note">
        {t('settings.realms.worldRead', { source: world.source, family, version })}
      </p>
      {familiesDisagree({ data: world.family, server: world.server }) && world.server !== null && (
        <p className="settings-warn">
          {t('session.realm.familyDisagrees', {
            server: REALM_FAMILY_LABEL[world.server],
            data: family,
            source: world.source
          })}
        </p>
      )}
    </>
  );
}
