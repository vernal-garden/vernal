import { useState } from 'react';
import { patch } from '../../lib/api';
import type { AccountData } from './types';
import {
  cardSt,
  cardTitleSt,
  labelSt,
  inputSt,
  primaryButtonSt,
  linkButtonSt,
  errorTextSt,
  successTextSt,
  apiErrorMessage,
} from './settingsStyles';

interface Props {
  account: AccountData;
  onUpdate: (patch: Partial<AccountData>) => void;
}

export default function ProfileSettings({ account, onUpdate }: Props) {
  const [displayName, setDisplayName] = useState(account.displayName ?? '');
  const [zone, setZone] = useState(account.zone);
  const [zoneLocationLabel, setZoneLocationLabel] = useState(account.zoneLocationLabel);
  const [lastSpringFrostDate, setLastSpringFrostDate] = useState<string | null>(account.lastSpringFrostDate);
  const [firstFallFrostDate, setFirstFallFrostDate] = useState<string | null>(account.firstFallFrostDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const body: Record<string, unknown> = {};
    if (displayName.trim() !== (account.displayName ?? '')) body.displayName = displayName.trim();
    if (zone.trim() !== account.zone) body.zone = zone.trim();
    if (zoneLocationLabel.trim() !== account.zoneLocationLabel) body.zoneLocationLabel = zoneLocationLabel.trim();
    if (lastSpringFrostDate !== account.lastSpringFrostDate) body.lastSpringFrostDate = lastSpringFrostDate;
    if (firstFallFrostDate !== account.firstFallFrostDate) body.firstFallFrostDate = firstFallFrostDate;

    if (Object.keys(body).length === 0) return;

    setSaving(true);
    try {
      const res = await patch<{ data: Partial<AccountData> }>('/api/me', body);
      onUpdate(res!.data);
      setSuccess(true);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save your profile.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 style={{ margin: '0 0 var(--sp-4)', fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--c-text)' }}>
        Profile
      </h2>

      <form onSubmit={handleSubmit} style={cardSt}>
        <h3 style={cardTitleSt}>Basics</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>
          <div>
            <label htmlFor="displayName" style={labelSt}>Display name</label>
            <input
              id="displayName"
              type="text"
              maxLength={60}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={inputSt}
            />
          </div>

          <div>
            <label htmlFor="zone" style={labelSt}>Hardiness zone</label>
            <input
              id="zone"
              type="text"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              style={inputSt}
            />
          </div>

          <div>
            <label htmlFor="zoneLocationLabel" style={labelSt}>Zone location</label>
            <input
              id="zoneLocationLabel"
              type="text"
              maxLength={80}
              value={zoneLocationLabel}
              onChange={(e) => setZoneLocationLabel(e.target.value)}
              style={inputSt}
            />
          </div>

          <div>
            <label htmlFor="lastSpringFrostDate" style={labelSt}>Last spring frost date</label>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
              <input
                id="lastSpringFrostDate"
                type="date"
                value={lastSpringFrostDate ?? ''}
                onChange={(e) => setLastSpringFrostDate(e.target.value || null)}
                style={inputSt}
              />
              {lastSpringFrostDate && (
                <button type="button" onClick={() => setLastSpringFrostDate(null)} style={linkButtonSt}>
                  Clear
                </button>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="firstFallFrostDate" style={labelSt}>First fall frost date</label>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
              <input
                id="firstFallFrostDate"
                type="date"
                value={firstFallFrostDate ?? ''}
                onChange={(e) => setFirstFallFrostDate(e.target.value || null)}
                style={inputSt}
              />
              {firstFallFrostDate && (
                <button type="button" onClick={() => setFirstFallFrostDate(null)} style={linkButtonSt}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 'var(--sp-5)' }}>
          <button type="submit" disabled={saving} style={primaryButtonSt}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>

        {success && <p style={successTextSt}>Profile saved.</p>}
        {error && <p style={errorTextSt}>{error}</p>}
      </form>
    </section>
  );
}
