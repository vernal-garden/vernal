import { test, expect, type Page } from '@playwright/test';
import {
  resetTestDb, createTestUser, createTestGarden, closePool, markUnverified, createResetToken,
  getDisplacement, createVerificationToken, isVerificationTokenLive, createPendingTakeover,
  getAccountState, getAccountIdByEmail, markVerified, setAccountEmail,
} from './helpers/db';

// The unverified-account question: someone who proves the inbox of an account
// whose address was never verified is asked whether they created it. None of
// these accounts has a Stripe id, so no displacement path reaches Stripe.

const PASSWORD = 'Takeover123!';
const QUESTION = 'This address already has a Vernal account that was never verified. Did you create it?';
const REPLACE_BODY =
  "We'll remove that account and set you up with a fresh one. The earlier account's data will be deleted after 30 days.";
const REMOVE_BODY = "We'll remove this account. Its data will be deleted after 30 days.";
const NOT_ME_BODY =
  "Someone created a Vernal account with this email address and never verified it. If it wasn't you, we'll remove it. Its data will be deleted after 30 days.";
const REMOVED = "The account was removed. You don't need to do anything else.";
const ALREADY_VERIFIED_HEADING = 'Already verified';
const ALREADY_VERIFIED_BODY =
  "This account has already been verified, so it can't be removed from this link. If you didn't create it, email hello@vernal.garden and we'll sort it out.";
const EXPIRED_HEADING = 'This link has expired';
const EXPIRED_BODY =
  'If someone created a Vernal account with your email address and you want it removed, go to Sign in, choose "Forgot password?" and enter your address. We\'ll ask whether the account is yours.';
// --c-text-2: the body text colour on these screens.
const TEXT_2 = 'rgb(88, 79, 66)';
const TERMS_HEADING = 'Accept the Terms to continue';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

async function acceptTerms(page: Page): Promise<void> {
  await expect(page).toHaveURL('/beta-terms');
  const screen = page.getByTestId('beta-terms');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText(TERMS_HEADING);
  await page.getByTestId('terms-checkbox').check();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
}

async function sessionAccountId(page: Page): Promise<string> {
  const session = await (await page.request.get('/api/auth/session')).json();
  return String(session.data.account.id);
}

async function gardenNames(page: Page): Promise<string[]> {
  const gardens = await page.request.get('/api/gardens');
  expect(gardens.status()).toBe(200);
  return ((await gardens.json()).data as { name: string }[]).map((g) => g.name);
}

// The callback's browser cookie: the held sign-in only completes in this browser.
async function holdInBrowser(page: Page, browserToken: string): Promise<void> {
  await page.context().addCookies([
    { name: '_vernal_takeover', value: browserToken, domain: 'localhost', path: '/api/auth/takeover', httpOnly: true },
  ]);
}

async function expectQuestion(page: Page): Promise<void> {
  const heading = page.getByTestId('takeover-question');
  await expect(heading).toHaveText(QUESTION);
  await expect(heading).toBeFocused();
}

// Every question screen shows the address the question is about.
async function expectAddress(page: Page, email: string): Promise<void> {
  await expect(page.getByTestId('takeover-email')).toHaveText(email);
}

// The already-verified screen: its own heading, full-contrast body (not an
// error), the address as a mailto link, no buttons, and the fade-in finished.
async function expectAlreadyVerified(page: Page, screenId: string, headingId: string): Promise<void> {
  const screen = page.getByTestId(screenId);
  const heading = page.getByTestId(headingId);
  await expect(heading).toHaveText(ALREADY_VERIFIED_HEADING);
  await expect(heading).toBeFocused();
  const body = screen.getByTestId('already-verified-body');
  await expect(body).toHaveText(ALREADY_VERIFIED_BODY);
  await expect(body).toHaveCSS('color', TEXT_2);
  await expect(screen.getByRole('link', { name: 'hello@vernal.garden' })).toHaveAttribute(
    'href',
    'mailto:hello@vernal.garden',
  );
  await expect(screen.getByRole('alert')).toHaveCount(0);
  await expect(screen.getByRole('button')).toHaveCount(0);
  await expect(screen).toHaveCSS('opacity', '1');
}

// An expired or unknown "This wasn't me" link.
async function expectNotMeExpired(page: Page): Promise<void> {
  const screen = page.getByTestId('not-me');
  const heading = page.getByTestId('not-me-expired');
  await expect(heading).toHaveText(EXPIRED_HEADING);
  await expect(heading).toBeFocused();
  const body = screen.getByTestId('not-me-expired-body');
  await expect(body).toHaveText(EXPIRED_BODY);
  await expect(body).toHaveCSS('color', TEXT_2);
  await expect(screen.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login');
  await expect(screen.getByRole('button')).toHaveCount(0);
  await expect(screen).toHaveCSS('opacity', '1');
}

test.describe('password reset', () => {
  test("\"Yes, it's mine\" keeps the account: same id, garden kept, held at the Terms", async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-reset-mine@example.com', password: PASSWORD });
    await createTestGarden(user.id, 'Kept Garden');
    await markUnverified(user.id);
    const token = await createResetToken(user.id);

    await page.goto(`/reset-password?token=${token}`);
    await expectQuestion(page);
    await expectAddress(page, user.email);
    await page.getByRole('button', { name: "Yes, it's mine" }).click();

    // Focus moves to the password step's heading for a screen reader.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reset password');
    await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    await page.fill('#new-password', 'KeptPass123!');
    await page.fill('#confirm-password', 'KeptPass123!');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByText('Password updated — sign in to continue.')).toBeVisible();
    // The result is announced: focus moves to the success screen's heading.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reset password');
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();

    const state = await getAccountState(user.id);
    expect(state).toMatchObject({ emailVerified: true, claimed: true, displaced: false });

    await signIn(page, { email: user.email, password: 'KeptPass123!' });
    await acceptTerms(page);
    await expect(page).toHaveURL('/');
    expect(await gardenNames(page)).toEqual(['Kept Garden']);
    expect(await sessionAccountId(page)).toBe(user.id);
  });
});

test.describe('password reset, "No"', () => {
  test('the confirmation moves focus to the new-account password heading', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-reset-focus@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createResetToken(user.id);

    await page.goto(`/reset-password?token=${token}`);
    await expectQuestion(page);
    await expectAddress(page, user.email);
    await page.getByRole('button', { name: "No, I didn't" }).click();
    await page.getByRole('button', { name: 'Remove it' }).click();
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('Choose a password for your new account');
    await expect(heading).toBeFocused();
    expect(await getAccountState(user.id)).toMatchObject({ displaced: false });
  });

  test('the new-account password step submits with "Create account", under the Terms line', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-reset-create@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createResetToken(user.id);

    await page.goto(`/reset-password?token=${token}`);
    await expectQuestion(page);
    await page.getByRole('button', { name: "No, I didn't" }).click();
    await page.getByRole('button', { name: 'Remove it' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Choose a password for your new account');

    const submit = page.getByRole('button', { name: 'Create account', exact: true });
    await expect(submit).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update password' })).toHaveCount(0);
    const terms = page.getByTestId('auth-legal-notice');
    await expect(terms).toBeVisible();
    const termsBox = await terms.boundingBox();
    const submitBox = await submit.boundingBox();
    expect(termsBox && submitBox && termsBox.y < submitBox.y).toBe(true);

    await page.fill('#new-password', 'NewOwner123!');
    await page.fill('#confirm-password', 'NewOwner123!');
    await submit.click();
    await expect(page.getByText('Your new account is ready. Sign in to continue.', { exact: true })).toBeVisible();
    await expect(page.getByText('Password updated — sign in to continue.')).toHaveCount(0);
    const doneHeading = page.getByRole('heading', { level: 1 });
    await expect(doneHeading).toHaveText('Account created');
    await expect(doneHeading).toBeFocused();
    // A result screen: no Google button, Terms line or "or" divider.
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveCount(0);
    await expect(page.getByTestId('auth-legal-notice')).toHaveCount(0);
    await expect(page.getByText('or', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login');
    expect(await getAccountState(user.id)).toMatchObject({ displaced: true });
  });

  test('an account verified before "Create account" gets a plain reset, and the page says so', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-reset-raced@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createResetToken(user.id);

    await page.goto(`/reset-password?token=${token}`);
    await expectQuestion(page);
    await page.getByRole('button', { name: "No, I didn't" }).click();
    await page.getByRole('button', { name: 'Remove it' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Choose a password for your new account');
    await markVerified(user.id);

    await page.fill('#new-password', 'RacedPass123!');
    await page.fill('#confirm-password', 'RacedPass123!');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByText('Password updated — sign in to continue.')).toBeVisible();
    await expect(page.getByText('Your new account is ready. Sign in to continue.')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reset password');
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: true, displaced: false });
  });
});

test.describe('verification link', () => {
  test('not signed in as the account: "Yes" verifies and claims it', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-verify-mine@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id);

    await page.goto(`/verify-email?token=${token}`);
    await expectQuestion(page);
    await expectAddress(page, user.email);
    // The token is held in state while the address bar loses it.
    await expect(page).toHaveURL('/verify-email');
    await page.getByRole('button', { name: "Yes, it's mine" }).click();

    await expect(page.getByTestId('verify-email-claimed')).toHaveText('Email verified');
    await expect(page.getByTestId('verify-email-claimed')).toBeFocused();
    await expect(page.getByText('Your email address is verified. Sign in to continue.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: true, claimed: true, displaced: false });
  });

  test('inspect unavailable: the question from the verify POST still shows the address', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-verify-fallback@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id);
    await page.route('**/api/auth/verify-email/inspect', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }),
    );

    await page.goto(`/verify-email?token=${token}`);
    await expectQuestion(page);
    await expectAddress(page, user.email);
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: false, claimed: false });
  });

  test('not signed in as the account: "No" → Go back → "No" → "Remove it" removes it', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-verify-not-mine@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id);

    await page.goto(`/verify-email?token=${token}`);
    await expectQuestion(page);
    await page.getByRole('button', { name: "No, I didn't" }).click();
    await expect(page.getByTestId('takeover-confirm')).toBeFocused();
    await expect(page.getByText(REMOVE_BODY, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Go back' }).click();
    await expectQuestion(page);
    await page.getByRole('button', { name: "No, I didn't" }).click();
    await page.getByRole('button', { name: 'Remove it' }).click();

    await expect(page.getByText(REMOVED, { exact: true })).toBeVisible();
    expect(await getAccountState(user.id)).toMatchObject({ displaced: true });
    expect((await getDisplacement(user.id)).deleted).toBe(true);
  });

  test('signed in as the account: verifies straight away, no question', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-verify-signed-in@example.com', password: PASSWORD });
    await markUnverified(user.id);
    await signIn(page, user);
    const token = await createVerificationToken(user.id);

    await page.goto(`/verify-email?token=${token}`);
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    await expect(page.getByText('Thanks, your email address is confirmed.')).toBeVisible();
    await expect(page.getByTestId('takeover-question')).toHaveCount(0);
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: true, claimed: false, displaced: false });
  });

  test('signed in as the account only after the link was sent: asked first', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-verify-late-sign-in@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id);
    await signIn(page, user);

    await page.goto(`/verify-email?token=${token}`);
    await expectQuestion(page);
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: false, claimed: false });
    expect(await isVerificationTokenLive(token)).toBe(true);
  });

  test('"No" on an account verified meanwhile: the buttons give way to "Already verified"', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-verify-raced@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id);

    await page.goto(`/verify-email?token=${token}`);
    await expectQuestion(page);
    await page.getByRole('button', { name: "No, I didn't" }).click();
    await markVerified(user.id);
    await page.getByRole('button', { name: 'Remove it' }).click();

    await expectAlreadyVerified(page, 'verify-email', 'verify-email-already-verified');
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: true, displaced: false });
  });
});

test.describe('"This wasn\'t me" page', () => {
  test('loading changes nothing; "Remove it" removes the account', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-not-me@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id);

    await page.goto(`/not-me?token=${token}`);
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('Remove this Vernal account?');
    await expect(heading).toBeFocused();
    await expect(page.getByText(NOT_ME_BODY, { exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: false, displaced: false });
    expect(await isVerificationTokenLive(token)).toBe(true);

    await page.getByRole('button', { name: 'Remove it' }).click();
    await expect(page.getByText(REMOVED, { exact: true })).toBeVisible();
    expect(await getAccountState(user.id)).toMatchObject({ displaced: true });
    expect(await isVerificationTokenLive(token)).toBe(false);
  });

  test('an already-verified account says so straight away, with no button', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-not-me-verified@example.com', password: PASSWORD });
    const token = await createVerificationToken(user.id);

    await page.goto(`/not-me?token=${token}`);
    await expectAlreadyVerified(page, 'not-me', 'not-me-already-verified');
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: true, displaced: false });
    expect(await isVerificationTokenLive(token)).toBe(true);
  });

  test('an account verified after the page loaded shows "Already verified" and stays', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-not-me-raced@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id);

    await page.goto(`/not-me?token=${token}`);
    await expect(page.getByRole('button', { name: 'Remove it' })).toBeVisible();
    await markVerified(user.id);
    await page.getByRole('button', { name: 'Remove it' }).click();
    await expectAlreadyVerified(page, 'not-me', 'not-me-already-verified');
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: true, displaced: false });
  });

  test('an unknown link shows the expired screen, pointing to Sign in', async ({ page }) => {
    await page.goto('/not-me?token=not-a-real-token');
    await expectNotMeExpired(page);
  });

  test('an expired link shows the expired screen', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-not-me-expired@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id, { expiresIn: '-1 minute' });

    await page.goto(`/not-me?token=${token}`);
    await expectNotMeExpired(page);
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: false, displaced: false });
  });

  test('a link too close to expiry to act on shows the expired screen, not "request a new one"', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-not-me-nearly@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id, { expiresIn: '1 minute' });

    await page.goto(`/not-me?token=${token}`);
    await page.getByRole('button', { name: 'Remove it' }).click();
    await expectNotMeExpired(page);
    await expect(page.getByText(/request a new one/i)).toHaveCount(0);
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: false, displaced: false });
  });
});

test.describe('held Google sign-in (/claim-account)', () => {
  test('"Yes, it\'s mine" keeps the account and signs in, held at the Terms', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-google-mine@example.com', password: PASSWORD });
    await createTestGarden(user.id, 'Google Kept Garden');
    await markUnverified(user.id);
    const { token, browserToken } = await createPendingTakeover(user.id);
    await holdInBrowser(page, browserToken);

    await page.goto(`/claim-account?token=${token}`);
    await expectQuestion(page);
    await expectAddress(page, user.email);
    await page.getByRole('button', { name: "Yes, it's mine" }).click();

    await acceptTerms(page);
    await expect(page).toHaveURL('/');
    expect(await sessionAccountId(page)).toBe(user.id);
    expect(await gardenNames(page)).toEqual(['Google Kept Garden']);
    expect(await getAccountState(user.id)).toMatchObject({
      emailVerified: true, claimed: true, displaced: false, hasPassword: false,
    });
  });

  test('"No" → "Remove it" removes the account and signs in to a new one', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-google-not-mine@example.com', password: PASSWORD });
    await createTestGarden(user.id, 'Squatter Garden');
    await markUnverified(user.id);
    const { token, browserToken } = await createPendingTakeover(user.id);
    await holdInBrowser(page, browserToken);

    await page.goto(`/claim-account?token=${token}`);
    await expectQuestion(page);
    await page.getByRole('button', { name: "No, I didn't" }).click();
    await expect(page.getByText(REPLACE_BODY, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Go back' }).click();
    await expectQuestion(page);
    await page.getByRole('button', { name: "No, I didn't" }).click();
    await page.getByRole('button', { name: 'Remove it' }).click();

    // A new account with no gardens lands on onboarding.
    await expect(page).toHaveURL('/onboarding');
    const newId = await sessionAccountId(page);
    expect(newId).not.toBe(user.id);
    expect(await getAccountIdByEmail(user.email)).toBe(newId);
    expect(await gardenNames(page)).toEqual([]);
    expect(await getDisplacement(user.id)).toEqual({
      email: `displaced-${user.id}@displaced.invalid`,
      displaced: true,
      deleted: true,
    });
  });

  test('an expired sign-in shows the expired message with a way back to sign in', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-google-expired@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const { token, browserToken } = await createPendingTakeover(user.id, { expired: true });
    await holdInBrowser(page, browserToken);

    await page.goto(`/claim-account?token=${token}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This sign-in has expired. Please sign in with Google again.',
    );
    await expect(page.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
    await expect(page.getByTestId('takeover-question')).toHaveCount(0);
    expect(await getAccountState(user.id)).toMatchObject({ emailVerified: false, displaced: false });
  });

  test('the link without this browser\'s cookie is treated as expired', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-google-other-browser@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const { token } = await createPendingTakeover(user.id);

    await page.goto(`/claim-account?token=${token}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This sign-in has expired. Please sign in with Google again.',
    );
    await expect(page.getByTestId('takeover-question')).toHaveCount(0);
  });

  test('an account that changed while deciding: the buttons give way to a fresh Google sign-in', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-google-changed@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const { token, browserToken } = await createPendingTakeover(user.id);
    await holdInBrowser(page, browserToken);

    await page.goto(`/claim-account?token=${token}`);
    await expectQuestion(page);
    // Meanwhile another unverified account takes the address.
    await setAccountEmail(user.id, 'takeover-google-changed-moved@example.com');
    const other = await createTestUser({ email: 'takeover-google-changed@example.com', password: PASSWORD });
    await markUnverified(other.id);
    await page.getByRole('button', { name: "Yes, it's mine" }).click();

    const heading = page.getByTestId('claim-account-changed');
    await expect(heading).toHaveText('The account changed while you were deciding. Please sign in with Google again.');
    await expect(heading).toBeFocused();
    await expect(page.getByTestId('claim-account').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Sign in with Google again' })).toHaveAttribute(
      'href',
      '/api/auth/oauth/google?returnTo=%2F',
    );
    expect(await getAccountState(other.id)).toMatchObject({ emailVerified: false, claimed: false });
  });
});

test.describe('cross-site requests', () => {
  test('a form POST to login from another site is refused', async ({ page }) => {
    const user = await createTestUser({ email: 'takeover-csrf@example.com', password: PASSWORD });
    const res = await page.request.post('/api/auth/login', {
      form: { email: user.email, password: PASSWORD },
      headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(res.status()).toBe(403);
    expect(await res.json()).toEqual({ error: 'Cross-site request refused.' });
  });
});

test.describe('feedback bubble', () => {
  test('hidden on the verification link and "This wasn\'t me" pages', async ({ page }) => {
    const fab = page.getByRole('button', { name: 'Send feedback' });
    // Shown elsewhere, so its absence below means something.
    await page.goto('/privacy');
    await expect(fab).toBeVisible();

    const user = await createTestUser({ email: 'takeover-feedback-hidden@example.com', password: PASSWORD });
    await markUnverified(user.id);
    const token = await createVerificationToken(user.id);
    await page.goto(`/verify-email?token=${token}`);
    await expectQuestion(page);
    await expect(fab).toHaveCount(0);

    await page.goto(`/not-me?token=${token}`);
    await expect(page.getByRole('button', { name: 'Remove it' })).toBeVisible();
    await expect(fab).toHaveCount(0);

    await page.goto('/not-me?token=not-a-real-token');
    await expect(page.getByTestId('not-me-expired')).toBeVisible();
    await expect(fab).toHaveCount(0);
  });
});

test.describe('wording', () => {
  test('the register page shows the verification line', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('#email-verify-notice')).toHaveText(
      'Please verify your email address. Until you do, whoever controls this address can take over this account or have it removed.',
    );
  });

  test('the privacy page explains unverified accounts', async ({ page }) => {
    await page.goto('/privacy');
    const entry = page.locator('li', { has: page.locator('strong', { hasText: 'Unverified accounts:' }) });
    await expect(entry).toHaveText(
      "Unverified accounts: if an account’s email address is never verified, the next person to prove they control that address, by verifying it, resetting the password, or signing in with Google, is asked whether they created the account. If they say yes, the account stays as it is. If they say no, or use the “This wasn’t me” link in the verification email, we treat the account as created by someone else and delete it after 30 days. Someone who says no while signing in gets a new account of their own. Questions about an account removed this way can go to hello@vernal.garden during that period.",
    );
    await expect(entry.getByRole('link', { name: 'hello@vernal.garden' })).toHaveAttribute(
      'href',
      'mailto:hello@vernal.garden',
    );
  });
});
