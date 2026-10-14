import { db } from '../db';
import { LOCATION_NOT_SET } from '../constants';

export async function getAccountLocation(accountId: number): Promise<string | null> {
  const { rows } = await db.query<{ zone_location_label: string }>(
    'SELECT zone_location_label FROM accounts WHERE id = $1',
    [accountId],
  );
  const label = rows[0]?.zone_location_label;
  return label && label !== LOCATION_NOT_SET ? label : null;
}
