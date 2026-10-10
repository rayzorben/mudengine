import AreaSearchDialog, { type AreaSearchDialogProps } from './AreaSearchDialog';
import CashRunDialog, { type CashRunDialogProps } from './CashRunDialog';
import type { TripDialogs as TripDialogState } from '../hooks/useTripDialogs';

export interface TripDialogsProps {
  api: AreaSearchDialogProps['api'] & CashRunDialogProps['api'];
  trips: TripDialogState;
  profiles: AreaSearchDialogProps['profiles'];
}

/** The two trip dialogs the palette opens; at most one is open at a time. */
export default function TripDialogs({ api, trips, profiles }: TripDialogsProps): React.JSX.Element {
  return (
    <>
      <AreaSearchDialog api={api} area={trips.area} profiles={profiles} />
      <CashRunDialog api={api} cash={trips.cash} profiles={profiles} />
    </>
  );
}
