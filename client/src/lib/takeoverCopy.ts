// Copy for the unverified-account question: someone proved the inbox of an
// account whose address was never verified (password reset, Google sign-in,
// or the verification link) and is asked whether they created it.
//
// All of this file's text is final copy approved by General Counsel, word for
// word, except where a comment marks it as working text: any change to the
// approved text goes back to General Counsel.

export const TAKEOVER_QUESTION_COPY = {
  question: 'This address already has a Vernal account that was never verified. Did you create it?',
  yes: "Yes, it's mine",
  no: "No, I didn't",
};

// The "No" confirmation where a fresh account follows (password reset and
// Google sign-in).
export const TAKEOVER_REPLACE_COPY = {
  heading: 'Remove the earlier account?',
  body: "We'll remove that account and set you up with a fresh one. The earlier account's data will be deleted after 30 days.",
  remove: 'Remove it',
  back: 'Go back',
};

// The "No" confirmation on the verification link, where no fresh account follows.
export const TAKEOVER_REMOVE_COPY = {
  heading: 'Remove this account?',
  body: "We'll remove this account. Its data will be deleted after 30 days.",
  remove: 'Remove it',
  back: 'Go back',
};

// The "This wasn't me" page (/not-me), and the done state after a removal
// from the verification link.
export const NOT_ME_COPY = {
  heading: 'Remove this Vernal account?',
  body: "Someone created a Vernal account with this email address and never verified it. If it wasn't you, we'll remove it. Its data will be deleted after 30 days.",
  remove: 'Remove it',
  removing: 'Removing…',
  doneHeading: 'Account removed',
  done: "The account was removed. You don't need to do anything else.",
};

// The account was already verified, on /not-me and on the verification link.
// The address in the body is a mailto link: body, email, then bodyEnd.
export const ALREADY_VERIFIED_COPY = {
  heading: 'Already verified',
  body: "This account has already been verified, so it can't be removed from this link. If you didn't create it, email ",
  email: 'hello@vernal.garden',
  bodyEnd: " and we'll sort it out.",
};

// An expired or unknown "This wasn't me" link (/not-me), including one too
// close to expiry to act on. The person may have no account, so there is no
// link to request: Sign in links to /login. Body: body, signIn, bodyEnd.
export const NOT_ME_EXPIRED_COPY = {
  heading: 'This link has expired',
  body: 'If someone created a Vernal account with your email address and you want it removed, go to ',
  signIn: 'Sign in',
  bodyEnd: `, choose "Forgot password?" and enter your address. We'll ask whether the account is yours.`,
};

export const TAKEOVER_MISC_COPY = {
  // Reset password, after "No": the password is for the fresh account.
  newAccountPasswordTitle: 'Choose a password for your new account',
  newAccountSubmit: 'Create account',
  // Working text, awaiting General Counsel: after "Create account" succeeds.
  newAccountDoneHeading: 'Account created',
  newAccountDone: 'Your new account is ready. Sign in to continue.',
  // Verification link, after "Yes": every session was signed out.
  verifiedHeading: 'Email verified',
  verifiedSignIn: 'Your email address is verified. Sign in to continue.',
  signIn: 'Sign in',
  checking: 'Checking your link…',
  backToSignIn: 'Back to sign in',
  // Google sign-in, when the account changed while the person was deciding.
  googleAgain: 'Sign in with Google again',
  failed: 'Something went wrong. Please try again.',
};
