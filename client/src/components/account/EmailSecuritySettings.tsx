import { useState } from 'react';
import { patch, del } from '../../lib/api';
import type { AccountData } from './types';
import {
  cardSt,
  cardTitleSt,
  bodyTextSt,
  labelSt,
  inputSt,
  primaryButtonSt,
  secondaryButtonSt,
  errorTextSt,
  successTextSt,
  apiErrorMessage,
} from './settingsStyles';

interface Props {
  account: AccountData;
  onUpdate: (patch: Partial<AccountData>) => void;
}

function EmailSection({ account, onUpdate }: Props) {
  const [newEmail, setNewEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      const res = await patch<{ data: { pendingEmail: string } }>('/api/me/email', { newEmail });
      onUpdate({ pendingEmail: res!.data.pendingEmail });
      setNewEmail('');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not start the email change.'));
    } finally {
      setSending(false);
    }
  }

  async function handleCancel() {
    setError(null);
    setCancelling(true);
    try {
      await del('/api/me/email');
      onUpdate({ pendingEmail: null });
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not cancel the email change.'));
    } finally {
      setCancelling(false);
    }
  }

  if (!account.isPasswordAccount) {
    return (
      <div style={cardSt}>
        <h3 style={cardTitleSt}>Email</h3>
        <p style={bodyTextSt}>Your account uses an external sign-in. Email change is not available.</p>
      </div>
    );
  }

  return (
    <div style={cardSt}>
      <h3 style={cardTitleSt}>Email</h3>
      <p style={bodyTextSt}>{account.email}</p>

      {account.pendingEmail ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <p style={bodyTextSt}>
            Confirmation sent to {account.pendingEmail}. Check your inbox and click the link to confirm.
            The link expires in 24 hours.
          </p>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <button type="button" onClick={handleCancel} disabled={cancelling} style={secondaryButtonSt}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSend} style={{ marginTop: 'var(--sp-4)' }}>
          <label htmlFor="newEmail" style={labelSt}>New email address</label>
          <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
            <input
              id="newEmail"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              style={{ ...inputSt, flex: '1 1 240px' }}
            />
            <button type="submit" disabled={sending || !newEmail} style={primaryButtonSt}>
              {sending ? 'Sending…' : 'Send confirmation'}
            </button>
          </div>
        </form>
      )}

      {error && <p style={errorTextSt}>{error}</p>}
    </div>
  );
}

function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      await patch('/api/me/password', { currentPassword, newPassword });
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not update your password.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ ...cardSt, marginTop: 'var(--sp-4)' }}>
      <h3 style={cardTitleSt}>Password</h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>
        <div>
          <label htmlFor="currentPassword" style={labelSt}>Current password</label>
          <input
            id="currentPassword"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            style={inputSt}
          />
        </div>
        <div>
          <label htmlFor="newPassword" style={labelSt}>New password</label>
          <input
            id="newPassword"
            type="password"
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            style={inputSt}
          />
        </div>
      </div>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <button type="submit" disabled={saving || !currentPassword || newPassword.length < 8} style={primaryButtonSt}>
          {saving ? 'Updating…' : 'Update password'}
        </button>
      </div>

      {success && <p style={successTextSt}>Password updated.</p>}
      {error && <p style={errorTextSt}>{error}</p>}
    </form>
  );
}

export default function EmailSecuritySettings({ account, onUpdate }: Props) {
  return (
    <section>
      <h2 style={{ margin: '0 0 var(--sp-4)', fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--c-text)' }}>
        Email & Security
      </h2>
      <EmailSection account={account} onUpdate={onUpdate} />
      {account.isPasswordAccount && <PasswordSection />}
    </section>
  );
}
