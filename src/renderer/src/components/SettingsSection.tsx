import { createContext, useContext, type ReactNode } from 'react';

/**
 * Whether the form around a control is being searched. `Advanced` reads it to
 * draw what it holds, since a closed disclosure's fields are not in the
 * document for the search to find.
 */
const Searching = createContext(false);

export function useSearching(): boolean {
  return useContext(Searching);
}

export interface SettingsSectionProps {
  id: string;
  label: string;
  /** Every section is drawn, each under its own heading. */
  searching: boolean;
  children: ReactNode;
}

/**
 * One section of a settings form. Its box is `display: contents`, so the
 * fields stay items of the form's grid; the element is there for the search
 * to mark and for the section's hue. `mudengine-settings` › *Find a setting*.
 */
export default function SettingsSection({
  id,
  label,
  searching,
  children
}: SettingsSectionProps): React.JSX.Element {
  return (
    <div className="settings-section" data-label={label} data-section={id}>
      {searching && (
        <h3 className="settings-section-heading" data-section={id}>
          {label}
        </h3>
      )}
      <Searching.Provider value={searching}>{children}</Searching.Provider>
    </div>
  );
}
