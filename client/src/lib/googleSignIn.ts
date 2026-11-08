// Where "Continue with Google" starts the OAuth flow (a full page load, not fetch).
export function googleSignInHref(returnTo = '/'): string {
  return `/api/auth/oauth/google?returnTo=${encodeURIComponent(returnTo)}`;
}
