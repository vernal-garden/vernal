import type { PrivateBetaVersion } from '../context/ConfigContext';

// Final copy, cleared word for word: any change goes back to Vernal MD.
export const PRIVATE_BETA_COPY = {
  pageTitle: 'Private beta · Vernal',
  heading: 'Vernal is in private beta',
  signIn: 'Already have an account? Sign in',
  createAccount: 'Have an invite? Create your account',
  tryAnotherAddress: 'Try another address',
  refusedNotice:
    "That email address isn't on the invite list. If you were invited, use the address your invite went to, or email ",
  refusedEmail: 'robert@vernal.garden',
  refusedNoticeEnd: '.',
};

export const PRIVATE_BETA_VERSIONS: Record<PrivateBetaVersion, { body: string; action: string; href: string }> = {
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

// The heading is working text. So are notReady, notReadyBody and every terms*
// string (the main Terms after a claim), awaiting Vernal MD.
export const BETA_TERMS_COPY = {
  heading: 'One step before you start',
  termsHeading: 'Accept the Terms to continue',
  termsBody: "Your account's sign-in details changed, so we need you to accept the Terms again before you continue.",
  termsCheckboxBefore: 'I agree to the ',
  termsLink: 'Terms of Service',
  termsCheckboxMiddle: ' and have read the ',
  privacyLink: 'Privacy Policy',
  termsCheckboxAfter: '',
  checkboxBefore: "I'm 18 or older, and I've read and agree to the ",
  checkboxLink: 'Vernal beta terms',
  checkboxAfter: '.',
  continue: 'Continue',
  continuing: 'Continuing…',
  signOut: 'Sign out',
  failed: 'Something went wrong. Please try again.',
  notReady: 'Not ready to accept?',
  notReadyBody: 'These stay available without accepting.',
};

export const SUBSCRIPTION_BETA_COPY = {
  title: 'Vernal Supporter',
  line: 'Free for testers while the beta runs.',
};

function participants(count: number): string {
  return `${count} beta ${count === 1 ? 'participant' : 'participants'}`;
}

export const ADMIN_BETA_COPY = {
  subnav: { access: 'Access and invites', lifetime: 'Lifetime tier' },
  accessHeading: 'Access',
  testersHeading: 'What testers get',
  inviteHeading: 'Invite list',
  on: 'On',
  off: 'Off',
  saved: 'Saved. Takes effect within 30 seconds.',
  saveFailed: "Couldn't save. Try again.",
  gate: {
    label: 'Beta gate',
    description: 'On: only emails on the invite list can create an account. Off: anyone can sign up.',
    // UI-UX is amending this label.
    firstOn: (when: string) => `Guests from before ${when} can still sign up.`,
    confirmTitle: 'Turn off the beta gate?',
    confirmBody:
      'Anyone will be able to create an account until you turn it back on. Testers keep their Supporter access either way.',
    confirmLabel: 'Turn off gate',
  },
  guestMode: {
    label: 'Guest mode',
    description:
      "On: visitors can try Vernal without an account. Off: visitors who aren't signed in see the private-beta screen. Guest sessions already open run out their 30 days.",
  },
  supporter: {
    label: 'Beta testers get Supporter access',
    description:
      "On: every beta participant has Supporter features. Their stored plan doesn't change, and Users metrics count only real payers. Off: participants have whatever plan they actually hold.",
    separate: "Separate from the beta gate. Turning the gate off doesn't change this.",
    count: (n: number) => `${participants(n)}.`,
    confirmTitle: 'Turn off Supporter access for beta testers?',
    confirmBody: (n: number) =>
      `${participants(n)} will lose Supporter features unless they hold a paid plan of their own. Nothing they've saved is deleted.`,
    confirmLabel: 'Turn off',
  },
  counts: { invited: 'Invited', haveAccounts: 'Have accounts', participants: 'Beta participants' },
  add: {
    label: 'Add emails',
    helper:
      'Gmail ignores dots. If an invitee uses Gmail and might sign in with Google, add both forms (jane.doe@gmail.com and janedoe@gmail.com).',
    button: 'Add',
    failed: "Couldn't add these emails. Try again.",
    added: (n: number) => `Added ${n}.`,
    alreadyListed: (n: number) => `${n} ${n === 1 ? 'was' : 'were'} already on the list.`,
    // Can overlap with added or alreadyListed: a listed email's account may have come later.
    newParticipants: (n: number) =>
      n === 1
        ? '1 already had an account and is now a beta participant.'
        : `${n} already had accounts and are now beta participants.`,
    invalid: (entries: string[]) => `Not added, not an email: ${entries.join(', ')}`,
  },
  table: {
    search: 'Search by email',
    email: 'Email',
    added: 'Added',
    account: 'Account',
    actions: 'Actions',
    yes: (date: string) => `Yes · ${date}`,
    no: 'No',
    remove: 'Remove',
    removeLabel: (email: string) => `Remove ${email}`,
    empty: 'No invited emails yet.',
    noMatch: 'No invited emails match.',
    removed: (email: string, hadAccount: boolean) =>
      hadAccount ? `Removed ${email}. Their account and beta status are unchanged.` : `Removed ${email}.`,
    alreadyGone: (email: string) => `${email} was already off the list.`,
    removeFailed: (email: string) => `Couldn't remove ${email}. Try again.`,
  },
  cleanup: {
    label: 'Remove unused invites',
    description: "Use this when the beta ends. It deletes every invite that hasn't become an account.",
    button: 'Remove unused invites',
    confirmTitle: 'Remove unused invites?',
    confirmBody: (n: number) =>
      n === 1
        ? "1 invite hasn't become an account and will be deleted. Invites with accounts stay. This can't be undone."
        : `${n} invites haven't become accounts and will be deleted. Invites with accounts stay. This can't be undone.`,
    confirmLabel: 'Remove',
    removed: (n: number) => `Removed ${n} ${n === 1 ? 'invite' : 'invites'}.`,
    failed: "Couldn't remove unused invites. Try again.",
  },
  loadFailed: "Couldn't load beta access.",
  refreshFailed: "Couldn't refresh the invite list. Reload to see the latest.",
  retry: 'Retry',
};

// Robert's own screen; final unless he rewords.
export const ADMIN_LIFETIME_COPY = {
  heading: 'Lifetime tier',
  window: (day: string) =>
    `Counts run from each tester's join date to the end of ${day}. Weeks start Monday, Pacific.`,
  cards: {
    participants: 'Beta participants',
    qualify: 'Qualify',
    close: 'Close',
    noState: 'Qualify, no state yet',
    eligible: 'Eligible for the grant',
  },
  credit: {
    heading: 'Credit a survey',
    survey1: 'Survey 1',
    survey2: 'Survey 2',
    label: 'Emails',
    helper: 'Paste the emails of testers who finished this survey. Each tester can be credited once per survey.',
    button: 'Credit',
    credited: (n: number, s: number) => `Credited survey ${s} to ${n} ${n === 1 ? 'tester' : 'testers'}.`,
    already: (n: number, s: number) => `${n} already had survey ${s}.`,
    notParticipants: (list: string[]) => `Not beta participants: ${list.join(', ')}`,
    invalid: (list: string[]) => `Not an email: ${list.join(', ')}`,
    failed: "Couldn't credit these emails. Try again.",
  },
  table: {
    heading: 'Testers',
    search: 'Search by email',
    searchPlaceholder: 'name@example.com',
    csv: 'Download CSV',
    filters: {
      all: 'All',
      qualify: 'Qualify',
      close: 'Close',
      noState: 'Qualify, no state yet',
      eligible: 'Eligible',
      notYet: 'Not yet',
    },
    email: 'Email',
    joined: 'Joined',
    weeks: 'Weeks',
    feedback: 'Feedback',
    surveys: 'Surveys',
    status: 'Status',
    state: 'State',
    grant: 'Grant',
    invite: 'Invite',
    guest: 'Guest',
    outsideUs: 'Outside US',
    notAnswered: 'Not answered',
    notAsked: 'Not asked',
    eligible: 'Eligible',
    toggleLabel: (s: number, email: string) => `Survey ${s} credit for ${email}`,
    added: (s: number, email: string) => `Credited survey ${s} to ${email}.`,
    removed: (s: number, email: string) => `Removed survey ${s} from ${email}.`,
    failed: "Couldn't save. Try again.",
    empty: 'No beta participants yet.',
    emptyGroup: 'No testers in this group.',
    noMatch: 'No testers match.',
  },
  checkNote: 'To check state answers against the beta applications, compare the CSV with the application sheet.',
  loadFailed: "Couldn't load the lifetime tier.",
  retry: 'Retry',
};

// Working text, awaiting Vernal MD then General Counsel (spec LT-3, LT-6).
export const LIFETIME_STATE_COPY = {
  region: 'Lifetime tier',
  line: "You've earned the Vernal lifetime tier. Before it's applied, which state do you live in?",
  selectLabel: 'Your state',
  placeholder: 'Choose your state',
  territories: 'US territories',
  outside: 'I live outside the US',
  helper: 'State only. You can change it until the tier is applied.',
  outsideLine: 'The lifetime tier goes to people who live in the US, so your account moves to the free version at launch.',
  save: 'Save',
  notNow: 'Not now',
  about: 'About the lifetime tier',
  chip: 'Your state for the lifetime tier',
  toast: 'Saved. Thanks.',
  rowLabel: 'Where you live',
  answered: (name: string) => `Where you live: ${name}`,
  answeredOutside: 'Where you live: outside the US',
  change: 'Change',
  cancel: 'Cancel',
  saved: 'Saved.',
  failed: "Couldn't save. Try again.",
};
