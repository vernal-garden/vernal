import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import {
  resetTestDb, createTestUser, createTestGarden, createTestCambiumSeed, deleteCambiumSeedsLike, setAccountRole,
  setBetaState, holdAtBetaTerms, countGuestSessions, getBetaInviteEmails, getBetaAccount, closePool,
  setStripeCustomer, scheduleDeletion, clearDeletionsAndCustomers, markClaimed, getTermsAcceptance,
  markUnverified, createResetToken, getDisplacement,
} from './helpers/db';

// Phase 59. The switches are global to the one server every spec shares, so
// nothing else may run while this file has them flipped. That holds because the
// config runs one worker with fullyParallel off, and this file only matches the
// 'chromium' project; the first hook refuses to run under more workers. Tests
// stay in the default mode rather than 'serial' so one failure doesn't skip the
// rest. afterEach runs on failure too, and leaves the defaults in force.

const ADMIN = { email: 'beta-e2e-admin@example.com', password: 'BetaAdmin123!' };
const PASSWORD = 'BetaTester123!';
// Before any guest session this file opens, so none of them keeps the right to sign up.
const GATE_FIRST_ON_AT = new Date(Date.now() - 60 * 60 * 1000);

const SAVED = 'Saved. Takes effect within 30 seconds.';
const REFRESH_FAILED = "Couldn't refresh the invite list. Reload to see the latest.";
const REFUSED_NOTICE =
  "That email address isn't on the invite list. If you were invited, use the address your invite went to, or email robert@vernal.garden.";
const DELETION_NOTICE = 'Your account is scheduled for deletion. This will happen 30 days after you initiated the request.';

// Which one shows depends on the date, so tests ask the server (see landingCopy).
const PRIVATE_BETA_VERSIONS: Record<string, { body: string; action: string; href: string }> = {
  applications_open: {
    body: 'Only invited testers can use it right now. Beta applications are open through December 31.',
    action: 'Apply for the beta',
    href: 'https://vernal.garden/beta',
  },
  applications_closed: {
    body: 'Only invited testers can use it right now. Beta applications have closed, but you can join the waitlist to get an email when Vernal launches.',
    action: 'Join the waitlist',
    href: 'https://vernal.garden/#waitlist',
  },
};

let admin: APIRequestContext;

test.beforeAll(async ({ baseURL }, testInfo) => {
  if (testInfo.config.workers !== 1) {
    throw new Error('beta-access.spec.ts flips server-wide switches and needs workers: 1');
  }
  await resetTestDb();
  const account = await createTestUser({ ...ADMIN, displayName: 'Beta Admin' });
  await setAccountRole(account.id, 'admin');
  // A garden keeps '/' (where sign-in lands) from redirecting to /onboarding.
  await createTestGarden(account.id, 'Admin Garden');

  admin = await request.newContext({ baseURL });
  const login = await admin.post('/api/auth/login', { data: ADMIN });
  expect(login.ok()).toBe(true);
  await setBetaState(admin);
});

test.afterEach(async () => {
  await setBetaState(admin);
});

test.afterAll(async () => {
  // Unset when beforeAll failed before signing in.
  await admin?.dispose();
  await closePool();
});

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', user.password);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

async function fillRegister(page: Page, email: string): Promise<void> {
  await page.goto('/register');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
}

async function landingCopy(page: Page) {
  const config = await (await page.request.get('/api/config')).json();
  return PRIVATE_BETA_VERSIONS[config.privateBetaVersion];
}

async function expectLanding(page: Page, version?: string): Promise<void> {
  const copy = version ? PRIVATE_BETA_VERSIONS[version] : await landingCopy(page);
  const screen = page.getByTestId('private-beta');
  await expect(page).toHaveTitle('Private beta · Vernal');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Vernal is in private beta');
  await expect(screen.getByText(copy.body, { exact: true })).toBeVisible();
  await expect(page.getByTestId('private-beta-action')).toHaveText(copy.action);
  await expect(page.getByTestId('private-beta-action')).toHaveAttribute('href', copy.href);
  await expect(page.getByTestId('private-beta-sign-in')).toHaveText('Already have an account? Sign in');
  await expect(page.getByTestId('private-beta-create-account')).toHaveText('Have an invite? Create your account');
  await expect(page.getByTestId('private-beta-refused')).toHaveCount(0);
  await expect(page.getByTestId('private-beta-try-another')).toHaveCount(0);
}

async function expectRefused(page: Page): Promise<void> {
  const copy = await landingCopy(page);
  await expect(page.getByTestId('private-beta').getByRole('heading', { level: 1 })).toHaveText('Vernal is in private beta');
  await expect(page.getByTestId('private-beta-action')).toHaveText(copy.action);
  const notice = page.getByTestId('private-beta-refused');
  await expect(notice).toHaveText(REFUSED_NOTICE);
  await expect(notice.getByRole('link', { name: 'robert@vernal.garden' }))
    .toHaveAttribute('href', 'mailto:robert@vernal.garden');
  await expect(page.getByTestId('private-beta-try-another')).toHaveText('Try another address');
  await expect(page.getByTestId('private-beta-try-another')).toHaveAttribute('href', '/register');
  await expect(page.getByTestId('private-beta-sign-in')).toHaveCount(0);
  await expect(page.getByTestId('private-beta-create-account')).toHaveCount(0);
}

// The canvas controls render on the home page only, once its guards have settled.
async function expectHome(page: Page): Promise<void> {
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(page.getByTestId('beta-terms')).toHaveCount(0);
  expect((await page.request.get('/api/gardens')).status()).toBe(200);
}

test('guest mode off: a fresh visitor sees the private-beta landing and gets no session', async ({ page, context }) => {
  await setBetaState(admin, { guestModeOn: false });
  const sessionsBefore = await countGuestSessions();

  const guestPost = page.waitForResponse((r) => r.url().endsWith('/api/auth/guest') && r.request().method() === 'POST');
  await page.goto('/');
  const refused = await guestPost;
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe('guest_mode_off');

  await expect(page).toHaveURL('/private-beta');
  await expectLanding(page);

  await page.waitForLoadState('networkidle');
  expect(await countGuestSessions()).toBe(sessionsBefore);
  expect((await context.cookies()).filter((c) => c.name === '_vernal_sid')).toEqual([]);
});

test('gate on: an uninvited email lands on the refused state, and reload shows landing', async ({ page }) => {
  await setBetaState(admin, { gateOn: true, gateFirstOnAt: GATE_FIRST_ON_AT });
  const email = 'beta-e2e-uninvited@example.com';

  await fillRegister(page, email);
  await page.getByTestId('beta-terms-checkbox').check();
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL('/private-beta');
  await expectRefused(page);
  expect(await getBetaAccount(email)).toBeNull();

  await page.reload();
  await expect(page).toHaveURL('/private-beta');
  await expectLanding(page);

  // The Google callback's way in: the query is stripped, and reload shows landing too.
  await page.goto('/private-beta?refused=1');
  await expectRefused(page);
  await expect(page).toHaveURL('/private-beta');
  await page.reload();
  await expectLanding(page);
});

test('gate on: an invited email registers and the Subscription tab shows the Beta view', async ({ page }) => {
  const email = 'beta-e2e-invited@example.com';
  await setBetaState(admin, { gateOn: true, gateFirstOnAt: GATE_FIRST_ON_AT, invites: [email] });

  await fillRegister(page, email);
  const checkbox = page.getByTestId('beta-terms-checkbox');
  await expect(checkbox).toHaveAttribute('required', '');
  const label = page.locator('label', { has: checkbox });
  await expect(label).toHaveText("I'm 18 or older, and I've read and agree to the Vernal beta terms.");
  const terms = label.getByRole('link', { name: 'Vernal beta terms' });
  await expect(terms).toHaveAttribute('href', 'https://vernal.garden/beta/terms');
  await expect(terms).toHaveAttribute('target', '_blank');

  await checkbox.check();
  await page.click('button[type="submit"]');
  // A new account has no garden, so '/' sends it on to /onboarding.
  await expect(page).toHaveURL('/onboarding');

  const account = await getBetaAccount(email);
  expect(account?.betaParticipantAt).toBeTruthy();
  expect(account?.betaTermsVersion).toBeTruthy();
  expect(account?.betaTermsAcceptedAt).toBeTruthy();

  await page.goto('/account?section=subscription');
  const section = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Subscription' }) });
  await expect(section.getByRole('heading', { level: 3 })).toHaveText('Vernal Supporter');
  await expect(section.getByText('Free for testers while the beta runs.', { exact: true })).toBeVisible();
  await expect(section.getByRole('button')).toHaveCount(0);
  await expect(section.getByRole('link')).toHaveCount(0);
  await expect(section.getByText('$')).toHaveCount(0);
  await expect(section.getByText('Free', { exact: true })).toHaveCount(0);
});

test('an existing account added to the list is held at /beta-terms until it accepts', async ({ page }) => {
  const user = await createTestUser({ email: 'beta-e2e-existing@example.com', password: PASSWORD });
  await createTestGarden(user.id, 'Existing Garden');
  await signIn(page, user);
  await expect(page).toHaveURL('/');

  const added = await admin.post('/api/admin/beta/invites', { data: { emails: user.email } });
  expect(added.ok()).toBe(true);
  expect((await added.json()).newParticipants).toEqual([user.email]);

  await page.reload();
  await expect(page).toHaveURL('/beta-terms');
  const screen = page.getByTestId('beta-terms');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('One step before you start');
  await expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();

  // Held on the server as well as in the client, and on every guarded route.
  const gardens = await page.request.get('/api/gardens');
  expect(gardens.status()).toBe(403);
  expect((await gardens.json()).code).toBe('beta_terms_required');
  await page.goto('/account');
  await expect(page).toHaveURL('/beta-terms');

  await page.getByTestId('beta-terms-checkbox').check();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expectHome(page);

  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session.data.account.betaTermsRequired).toBe(false);
  expect((await getBetaAccount(user.email))?.betaTermsVersion).toBeTruthy();

  await page.reload();
  await expectHome(page);
});

test('an account held mid-visit goes to /beta-terms on its next API call, without a reload', async ({ page }) => {
  const user = await createTestUser({ email: 'beta-e2e-mid-visit@example.com', password: PASSWORD });
  await createTestGarden(user.id, 'Mid-visit Garden');
  await signIn(page, user);
  await page.goto('/gardens');
  await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });
  await holdAtBetaTerms(user.id);
  const refused = page.waitForResponse((r) => r.status() === 403);

  await page.getByRole('link', { name: 'Account' }).click();
  expect((await (await refused).json()).code).toBe('beta_terms_required');
  await expect(page).toHaveURL('/beta-terms');
  await expect(page.getByTestId('beta-terms').getByRole('heading', { level: 1 })).toHaveText('One step before you start');
  expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);

  await page.getByTestId('beta-terms-checkbox').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expectHome(page);
});

const TERMS_BODY = "Your account's sign-in details changed, so we need you to accept the Terms again before you continue.";

test('a claimed account is held at the main Terms until it accepts them', async ({ page }) => {
  const user = await createTestUser({ email: 'beta-e2e-claimed@example.com', password: PASSWORD });
  await createTestGarden(user.id, 'Claimed Garden');
  await markClaimed(user.id);
  await signIn(page, user);

  await expect(page).toHaveURL('/beta-terms');
  const screen = page.getByTestId('beta-terms');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Accept the Terms to continue');
  await expect(screen.getByText(TERMS_BODY, { exact: true })).toBeVisible();
  await expect(page.getByTestId('beta-terms-checkbox')).toHaveCount(0);

  const checkbox = page.getByTestId('terms-checkbox');
  await expect(checkbox).toHaveAttribute('required', '');
  const label = page.locator('label', { has: checkbox });
  await expect(label).toHaveText('I agree to the Terms of Service and have read the Privacy Policy');
  await expect(label.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
  await expect(label.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');

  const gardens = await page.request.get('/api/gardens');
  expect(gardens.status()).toBe(403);
  expect((await gardens.json()).code).toBe('terms_required');
  await page.goto('/account');
  await expect(page).toHaveURL('/beta-terms');

  await page.getByTestId('terms-checkbox').check();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expectHome(page);

  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session.data.account.termsRequired).toBe(false);
  expect((await getTermsAcceptance(user.email))?.termsVersion).toBeTruthy();
});

test('a claimed beta participant accepts the main Terms and the beta terms together', async ({ page }) => {
  const user = await createTestUser({ email: 'beta-e2e-claimed-participant@example.com', password: PASSWORD });
  await createTestGarden(user.id, 'Claimed Participant Garden');
  await holdAtBetaTerms(user.id);
  await markClaimed(user.id);
  await signIn(page, user);

  await expect(page).toHaveURL('/beta-terms');
  const screen = page.getByTestId('beta-terms');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('One step before you start');
  await expect(screen.getByText(TERMS_BODY, { exact: true })).toBeVisible();
  await expect(page.getByTestId('terms-checkbox')).toBeVisible();
  await expect(page.getByTestId('beta-terms-checkbox')).toBeVisible();

  // Both are required: one tick alone leaves the form unsent.
  await page.getByTestId('terms-checkbox').check();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL('/beta-terms');
  expect((await getTermsAcceptance(user.email))?.termsVersion).toBeNull();

  await page.getByTestId('beta-terms-checkbox').check();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expectHome(page);

  expect((await getTermsAcceptance(user.email))?.termsVersion).toBeTruthy();
  expect((await getBetaAccount(user.email))?.betaTermsVersion).toBeTruthy();
});

test('a reset on an unverified account gives the owner a new, empty account held at the Terms', async ({ page }) => {
  const squatter = await createTestUser({ email: 'beta-e2e-displaced@example.com', password: PASSWORD });
  await createTestGarden(squatter.id, 'Squatter Garden');
  await markUnverified(squatter.id);
  const token = await createResetToken(squatter.id);

  await page.goto(`/reset-password?token=${token}`);
  // Asked first whether they created the account; "Go back" returns to the question.
  const question = page.getByTestId('takeover-question');
  await expect(question).toHaveText(
    'This address already has a Vernal account that was never verified. Did you create it?',
  );
  await expect(question).toBeFocused();
  await page.getByRole('button', { name: "No, I didn't" }).click();
  await expect(page.getByTestId('takeover-confirm')).toBeFocused();
  await expect(page.getByText(
    "We'll remove that account and set you up with a fresh one. The earlier account's data will be deleted after 30 days.",
    { exact: true },
  )).toBeVisible();
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(question).toBeFocused();
  await page.getByRole('button', { name: "No, I didn't" }).click();
  await page.getByRole('button', { name: 'Remove it' }).click();
  // Nothing has changed until the password is set.
  expect((await getDisplacement(squatter.id)).displaced).toBe(false);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Choose a password for your new account');
  await page.fill('#new-password', 'OwnerPass123!');
  await page.fill('#confirm-password', 'OwnerPass123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Your new account is ready. Sign in to continue.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account created');

  // The earlier account is deleted and lets go of the address.
  expect(await getDisplacement(squatter.id)).toEqual({
    email: `displaced-${squatter.id}@displaced.invalid`,
    displaced: true,
    deleted: true,
  });

  await signIn(page, { email: squatter.email, password: 'OwnerPass123!' });
  await expect(page).toHaveURL('/beta-terms');
  const screen = page.getByTestId('beta-terms');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Accept the Terms to continue');
  await page.getByTestId('terms-checkbox').check();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();

  // A new account: none of the earlier account's gardens.
  await expect(page).toHaveURL('/onboarding');
  const gardens = await page.request.get('/api/gardens');
  expect(gardens.status()).toBe(200);
  expect((await gardens.json()).data).toEqual([]);
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(String(session.data.account.id)).not.toBe(squatter.id);
});

test('a guest garden is offered for merging before the terms, so Sign out cannot delete it', async ({ page, context }) => {
  const seedName = 'Beta E2E Merge Basil';
  try {
    const user = await createTestUser({ email: 'beta-e2e-merge@example.com', password: PASSWORD });
    await holdAtBetaTerms(user.id);
    // So the deletion notice has something to show once the prompt resolves.
    await scheduleDeletion(user.id);

    await page.goto('/onboarding');
    // The client mints the guest session asynchronously after first load.
    await expect.poll(async () => (await context.cookies()).some((c) => c.name === '_vernal_sid')).toBe(true);
    const garden = await page.request.post('/api/gardens', {
      data: { name: 'Merge Garden', style: 'grid', zone: '7b', growingMethod: 'raised_bed' },
    });
    expect(garden.status(), await garden.text()).toBe(201);
    const gardenId = (await garden.json()).id;
    const bed = await page.request.post(`/api/gardens/${gardenId}/beds`, {
      data: { type: 'grid', label: 'Merge Bed', grid: { x: 6, y: 8, cols: 4, rows: 4 } },
    });
    expect(bed.status(), await bed.text()).toBe(201);
    const planting = await page.request.post(`/api/gardens/${gardenId}/beds/${(await bed.json()).id}/plantings`, {
      data: { cambiumSeedId: await createTestCambiumSeed(seedName), quantity: 1, cell: { x: 1, y: 1 } },
    });
    expect(planting.status(), await planting.text()).toBe(201);

    const refused: string[] = [];
    page.on('response', (r) => { if (r.status() === 403) refused.push(new URL(r.url()).pathname); });

    await signIn(page, user);
    await expect(page).toHaveURL('/beta-terms');
    await expect(page.getByRole('heading', { name: 'Add your guest garden to your account?' })).toBeVisible();
    await expect(page.getByText('Merge Garden — 1 bed, 1 plant', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(page.getByTestId('beta-terms-checkbox')).toHaveCount(0);
    await expect(page.getByText(DELETION_NOTICE, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel deletion' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Not ready to accept?' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Add to my account' }).click();
    await expect(page.getByRole('heading', { name: 'Add your guest garden to your account?' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'One step before you start' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByText(DELETION_NOTICE, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Not ready to accept?' })).toBeVisible();
    expect(refused).toEqual([]);

    await page.getByRole('button', { name: 'Cancel deletion' }).click();
    await expect(page.getByText(DELETION_NOTICE, { exact: true })).toHaveCount(0);

    await page.getByTestId('beta-terms-checkbox').check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expectHome(page);

    const { data } = await (await page.request.get('/api/gardens')).json();
    expect(data.map((g: { name: string; activePlantingCount: number }) => [g.name, g.activePlantingCount]))
      .toEqual([['Merge Garden', 1]]);
  } finally {
    await clearDeletionsAndCustomers();
    await deleteCambiumSeedsLike(seedName);
  }
});

test('/admin/beta: toggle guest mode, add two emails, remove one', async ({ page }) => {
  const first = 'beta-e2e-list-one@example.com';
  const second = 'beta-e2e-list-two@example.com';
  await signIn(page, ADMIN);
  await page.goto('/admin/beta');
  const main = page.getByRole('main');
  const stat = (label: string) => main.getByText(label, { exact: true }).locator('xpath=following-sibling::div');

  const guestMode = main.getByRole('switch', { name: 'Guest mode' });
  await expect(guestMode).toHaveAttribute('aria-checked', 'true');
  // The switch moves before the PATCH lands, and the page ignores clicks until it has.
  const toggleGuestMode = async (on: boolean) => {
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/admin/beta/settings'));
    await guestMode.click();
    expect((await saved).ok()).toBe(true);
    await expect(guestMode).toHaveAttribute('aria-checked', String(on));
    await expect(main.getByText(SAVED, { exact: true })).toBeVisible();
    // The admin's own change clears the cache, so the public config has it at once.
    expect((await (await page.request.get('/api/config')).json()).guestMode).toBe(on);
  };
  await toggleGuestMode(false);
  await toggleGuestMode(true);

  await expect(main.getByText('No invited emails yet.', { exact: true })).toBeVisible();
  await main.getByLabel(/^Add emails/).fill(`${first}\n${second}`);
  await main.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(main.getByText('Added 2.', { exact: true })).toBeVisible();
  await expect(main.getByRole('row', { name: new RegExp(first) })).toBeVisible();
  await expect(main.getByRole('row', { name: new RegExp(second) })).toBeVisible();
  await expect(stat('Invited')).toHaveText('2');
  await expect(main.getByLabel(/^Add emails/)).toHaveValue('');
  expect(await getBetaInviteEmails()).toEqual([first, second]);

  await main.getByRole('button', { name: `Remove ${first}`, exact: true }).click();
  await expect(main.getByText(`Removed ${first}.`, { exact: true })).toBeVisible();
  await expect(main.getByRole('row', { name: new RegExp(first) })).toHaveCount(0);
  await expect(main.getByRole('row', { name: new RegExp(second) })).toBeVisible();
  await expect(stat('Invited')).toHaveText('1');
  expect(await getBetaInviteEmails()).toEqual([second]);
});

test('/admin/beta: remove unused invites keeps the ones with accounts', async ({ page }) => {
  const unused = ['beta-e2e-unused-one@example.com', 'beta-e2e-unused-two@example.com'];
  // The admin's own address stands in for an invite that became an account.
  await setBetaState(admin, { invites: [ADMIN.email, ...unused] });
  await signIn(page, ADMIN);
  await page.goto('/admin/beta');
  const main = page.getByRole('main');
  const stat = (label: string) => main.getByText(label, { exact: true }).locator('xpath=following-sibling::div');
  await expect(stat('Invited')).toHaveText('3');
  await expect(
    main.getByText("Use this when the beta ends. It deletes every invite that hasn't become an account.", { exact: true }),
  ).toBeVisible();

  // Cancel first: nothing is deleted until the dialog is confirmed.
  await main.getByRole('button', { name: 'Remove unused invites', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove unused invites?' });
  await expect(dialog).toContainText("2 invites haven't become accounts and will be deleted.");
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await getBetaInviteEmails()).toHaveLength(3);

  await main.getByRole('button', { name: 'Remove unused invites', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(main.getByText('Removed 2 invites.', { exact: true })).toBeVisible();
  await expect(stat('Invited')).toHaveText('1');
  await expect(main.getByRole('row', { name: new RegExp(unused[0]) })).toHaveCount(0);
  await expect(main.getByRole('row', { name: new RegExp(ADMIN.email) })).toBeVisible();
  expect(await getBetaInviteEmails()).toEqual([ADMIN.email]);
});

test.describe('with the service worker blocked', () => {
  // page.route never sees a request the service worker makes.
  test.use({ serviceWorkers: 'block' });

  test('/admin/beta: a failed refresh shows inside the Supporter-access dialog', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/admin/beta');
    const main = page.getByRole('main');
    const supporter = main.getByRole('switch', { name: 'Beta testers get Supporter access' });
    await expect(supporter).toHaveAttribute('aria-checked', 'true');

    // Only now: the page has loaded, and the dialog's own refresh is what fails.
    await page.route(/\/api\/admin\/beta(\/invites)?$/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 500, json: { error: 'Internal server error' } })
        : route.continue());

    await supporter.click();
    const dialog = page.getByRole('dialog', { name: 'Turn off Supporter access for beta testers?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveText(REFRESH_FAILED);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(supporter).toHaveAttribute('aria-checked', 'true');
  });

  test('requests refused while the session is re-resolving trigger no second check', async ({ page }) => {
    const user = await createTestUser({ email: 'beta-e2e-batch@example.com', password: PASSWORD });
    await createTestGarden(user.id, 'Batch Garden');
    await signIn(page, user);
    await page.goto('/gardens');
    await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    await holdAtBetaTerms(user.id);
    let sessionChecks = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/auth/session', async (route) => {
      sessionChecks++;
      await held;
      await route.continue();
    });

    const first = page.waitForResponse((r) => r.status() === 403 && r.url().endsWith('/api/me'));
    await page.getByRole('link', { name: 'Account' }).click();
    await first;
    await expect.poll(() => sessionChecks).toBe(1);

    // The re-resolve is still out, so the app is still up and this page is refused too.
    const second = page.waitForResponse((r) => r.status() === 403 && !r.url().endsWith('/api/me'));
    await page.getByRole('link', { name: 'Seed Catalogue' }).click();
    await second;

    release();
    await expect(page).toHaveURL('/beta-terms');
    await page.waitForLoadState('networkidle');
    expect(sessionChecks).toBe(1);
  });

  test('the session call starts alongside /api/config, and only the routes wait for it', async ({ page }) => {
    const started: string[] = [];
    page.on('request', (r) => {
      const { pathname } = new URL(r.url());
      if (pathname === '/api/config' || pathname === '/api/auth/session') started.push(pathname);
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/\/api\/config$/, async (route) => {
      await held;
      await route.continue();
    });

    // The client gives up on the config after 5s, which would release a session call waiting for it.
    let configGaveUp = false;
    page.on('requestfailed', (r) => { if (r.url().endsWith('/api/config')) configGaveUp = true; });

    const session = page.waitForResponse((r) => r.url().endsWith('/api/auth/session'));
    const gardens = page.waitForResponse((r) => r.url().endsWith('/api/gardens'));
    await page.goto('/');
    expect((await session).ok()).toBe(true);
    expect((await gardens).ok()).toBe(true);

    // The guest state has settled, so a route that had stopped waiting would have
    // redirected and drawn by now. Two frames let that reach the page.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(configGaveUp).toBe(false);
    // A set: a fresh visitor calls the session route twice, neither call waiting for the config.
    expect(new Set(started)).toEqual(new Set(['/api/auth/session', '/api/config']));
    await expect(page).toHaveURL('/');
    await expect(page.locator('#root')).toBeEmpty();

    release();
    await expect(page).toHaveURL('/onboarding');
  });

  test('private beta: once applications close, the screen offers the waitlist', async ({ page }) => {
    await page.route(/\/api\/config$/, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), privateBetaVersion: 'applications_closed' } });
    });

    await page.goto('/private-beta');
    await expectLanding(page, 'applications_closed');
    await expect(page.getByTestId('private-beta').getByRole('link', { name: 'Join the waitlist' }))
      .toHaveAttribute('href', 'https://vernal.garden/#waitlist');
    await expect(page.getByText('Apply for the beta')).toHaveCount(0);
  });

  test.describe('held, and not ready to accept', () => {
    test.afterEach(async () => {
      await clearDeletionsAndCustomers();
    });

    // Before the first page load, which is when the client reads the config. Forced
    // on so the billing assertions can't pass just because this server has it off.
    async function forceBillingOn(page: Page): Promise<void> {
      await page.route(/\/api\/config$/, async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
      });
    }

    async function signInHeld(page: Page, email: string) {
      const user = await createTestUser({ email, password: PASSWORD });
      await createTestGarden(user.id, 'Held Garden');
      await holdAtBetaTerms(user.id);
      await signIn(page, user);
      await expect(page).toHaveURL('/beta-terms');
      return user;
    }

    // Opens the section and waits for the subscription read it starts, plus two
    // frames for that answer to reach the page.
    async function openSectionAndSettle(page: Page): Promise<void> {
      const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/subscription');
      await page.getByRole('button', { name: 'Not ready to accept?' }).click();
      expect((await read).status()).toBe(200);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    }

    async function deleteFromSection(page: Page): Promise<void> {
      await page.getByRole('button', { name: 'Delete account' }).click();
      const dialog = page.getByRole('dialog', { name: 'Confirm account deletion' });
      await dialog.getByRole('textbox').fill('delete');
      await dialog.getByRole('button', { name: 'Delete account' }).click();
    }

    test('the section starts closed, and an export can be requested from it', async ({ page }) => {
      await forceBillingOn(page);
      let subscriptionReads = 0;
      page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/subscription') subscriptionReads++; });
      await signInHeld(page, 'beta-e2e-export@example.com');

      const screen = page.getByTestId('beta-terms');
      const toggle = screen.getByRole('button', { name: 'Not ready to accept?' });
      const heading = screen.getByRole('heading', { name: 'Export your data' });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(heading).toHaveCount(0);
      await page.waitForLoadState('networkidle');
      expect(subscriptionReads).toBe(0);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(toggle).toBeFocused();
      await expect(screen.getByText('These stay available without accepting.', { exact: true })).toBeVisible();
      await expect(heading).toBeVisible();
      await expect.poll(() => subscriptionReads).toBe(1);

      const requested = page.waitForResponse((r) => r.url().endsWith('/api/me/export') && r.request().method() === 'POST');
      await screen.getByRole('button', { name: 'Request export' }).click();
      expect((await requested).status()).toBe(202);
      await expect(screen.getByText('Your export is ready.', { exact: true })).toBeVisible({ timeout: 30_000 });
      expect((await page.request.get('/api/me/export/download')).status()).toBe(200);
    });

    test('no billing customer: no Manage billing button', async ({ page }) => {
      await forceBillingOn(page);
      await signInHeld(page, 'beta-e2e-no-customer@example.com');

      await openSectionAndSettle(page);
      await expect(page.getByRole('button', { name: 'Delete account' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Manage billing' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'View payment history' })).toHaveCount(0);
    });

    test('a billing customer gets a button that opens the portal', async ({ page }) => {
      await forceBillingOn(page);
      const user = await signInHeld(page, 'beta-e2e-customer@example.com');
      await setStripeCustomer(user.id, 'cus_e2e_held');

      await page.route('**/e2e-billing-portal', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<h1>Billing portal</h1>' }));
      await page.route(/\/api\/subscription\/portal$/, (route) =>
        route.fulfill({ json: { url: new URL('/e2e-billing-portal', page.url()).href } }));

      await openSectionAndSettle(page);
      await page.getByRole('button', { name: 'Manage billing' }).click();
      await expect(page).toHaveURL('/e2e-billing-portal');
      await expect(page.getByRole('heading', { name: 'Billing portal' })).toBeVisible();
    });

    test('delete, sign back in still held, cancel the deletion, then accept', async ({ page }) => {
      await forceBillingOn(page);
      const user = await signInHeld(page, 'beta-e2e-delete@example.com');
      await setStripeCustomer(user.id, 'cus_e2e_held');
      await openSectionAndSettle(page);
      await expect(page.getByRole('button', { name: 'Manage billing' })).toBeVisible();
      await deleteFromSection(page);

      // Signing out ends on '/', and a fresh guest has no garden, so '/' sends it on.
      await expect(page).toHaveURL('/onboarding');
      const guest = (await (await page.request.get('/api/auth/session')).json()).data;
      expect(guest.authenticated).toBe(false);
      expect(guest.isGuest).toBe(true);

      await signIn(page, user);
      await expect(page).toHaveURL('/beta-terms');
      const screen = page.getByTestId('beta-terms');
      const notice = screen.getByText(DELETION_NOTICE, { exact: true });
      await expect(notice).toBeVisible();

      // The subscription isn't read while a deletion is scheduled, which is what keeps Manage billing away.
      let subscriptionReads = 0;
      page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/subscription') subscriptionReads++; });
      await screen.getByRole('button', { name: 'Not ready to accept?' }).click();
      await expect(screen.getByRole('heading', { name: 'Export your data' })).toBeVisible();
      await expect(screen.getByRole('button', { name: 'Delete account' })).toHaveCount(0);
      await expect(screen.getByRole('button', { name: 'Manage billing' })).toHaveCount(0);
      await page.waitForLoadState('networkidle');
      expect(subscriptionReads).toBe(0);

      await screen.getByRole('button', { name: 'Cancel deletion' }).click();
      await expect(notice).toHaveCount(0);
      await expect(page).toHaveURL('/beta-terms');
      await expect(screen.getByRole('button', { name: 'Delete account' })).toBeVisible();
      await expect(screen.getByRole('button', { name: 'Manage billing' })).toBeVisible();
      await expect(screen.getByRole('heading', { name: 'One step before you start' })).toBeFocused();
      const session = (await (await page.request.get('/api/auth/session')).json()).data;
      expect(session.account.deletionScheduledAt).toBeNull();
      expect(session.account.betaTermsRequired).toBe(true);

      await page.getByTestId('beta-terms-checkbox').check();
      await screen.getByRole('button', { name: 'Continue', exact: true }).click();
      await expectHome(page);
    });

    test('guest mode off: deleting lands on the private-beta screen with no session', async ({ page, context }) => {
      await setBetaState(admin, { guestModeOn: false });
      await signInHeld(page, 'beta-e2e-delete-private@example.com');
      await page.getByRole('button', { name: 'Not ready to accept?' }).click();
      await deleteFromSection(page);

      await expect(page).toHaveURL('/private-beta');
      await expectLanding(page);
      expect((await context.cookies()).filter((c) => c.name === '_vernal_sid')).toEqual([]);
    });
  });
});

test('restoring the defaults reaches the next visitor at once', async ({ page }) => {
  // setBetaState reads /api/config, so the server's cache now holds this state.
  await setBetaState(admin, { gateOn: true, guestModeOn: false, gateFirstOnAt: GATE_FIRST_ON_AT });
  await setBetaState(admin);
  const sessionsBefore = await countGuestSessions();

  await page.goto('/');
  await expect(page).toHaveURL('/onboarding');
  expect(await countGuestSessions()).toBe(sessionsBefore + 1);

  await page.goto('/register');
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.getByTestId('beta-terms-checkbox')).toHaveCount(0);
});
