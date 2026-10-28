import { Link } from 'react-router-dom';
import LegalPageLayout, { ContactLink, List, P, Section, legalLinkStyle } from '../components/legal/LegalPageLayout';
import { GOVERNING_STATE, OPERATOR_NAME } from '../lib/legal';

export default function PrivacyPage() {
  return (
    <LegalPageLayout title="Privacy Policy" testId="privacy-page">
      <P>
        This page explains what Vernal collects, why, who else sees it, and how long we keep it. We&rsquo;ve tried
        to keep it short and specific. If anything is unclear, write to us at <ContactLink />.
      </P>

      <Section title="Who we are">
        <P>
          Vernal is run by {OPERATOR_NAME} in {GOVERNING_STATE}, USA. When this policy says &ldquo;we&rdquo; or
          &ldquo;us&rdquo;, it means the people who run Vernal. You can reach us at <ContactLink />.
        </P>
      </Section>

      <Section title="What we collect">
        <List>
          <li>
            <strong>Your account.</strong> Your email address and display name. If you set a password, we store
            only a hash of it, never the password itself. If you sign in with Google, we store your Google account
            identity so we can recognise you next time.
          </li>
          <li>
            <strong>Your garden data.</strong> Everything you enter: gardens, beds, seeds, plantings, sowing and
            harvest records, photos, soil readings, amendment records and notes.
          </li>
          <li>
            <strong>Your location.</strong> The location and growing zone you set. We use them for frost dates,
            planting windows and weather.
          </li>
          <li>
            <strong>Weather station data.</strong> If you connect a WeatherFlow Tempest station, we store your
            station details and access token (encrypted) and the readings we fetch from it.
          </li>
          <li>
            <strong>What you send us.</strong> Feedback messages (with the screen you sent them from and the app
            version), answers to the short questions the app sometimes asks, corrections and new seeds you submit to
            the community seed catalogue, and the ratings you give catalogue seeds.
          </li>
          <li>
            <strong>Usage events.</strong> Which feature was used and when, linked to your account or guest
            session. We don&rsquo;t record what you type or where you click.
          </li>
          <li>
            <strong>Billing status.</strong> Your plan, its renewal date, and the customer and subscription IDs that
            link your account to Stripe. We never see or store your card number.
          </li>
        </List>
      </Section>

      <Section title="Using Vernal as a guest">
        <P>
          You can try Vernal without an account. Your gardens and seeds are then tied to a guest session cookie in
          your browser. If you create an account or sign in, that data moves to your account. If you don&rsquo;t,
          it&rsquo;s deleted when the guest session ends (see &ldquo;How long we keep data&rdquo; below).
        </P>
      </Section>

      <Section title="How we use it">
        <P>We use your information to:</P>
        <List>
          <li>run Vernal and show you your own data;</li>
          <li>work out frost dates, planting windows and weather guidance for where you garden;</li>
          <li>send account emails, such as email verification, password resets and email-change notices;</li>
          <li>handle subscriptions and payments;</li>
          <li>find and fix bugs;</li>
          <li>understand which features people use, so we know what to improve.</li>
        </List>
        <P>
          We don&rsquo;t sell your data. We don&rsquo;t show ads. We don&rsquo;t use your data to train AI models.
        </P>
      </Section>

      <Section title="Service providers">
        <P>We rely on a few other companies to run Vernal. Each one gets only what it needs:</P>
        <List>
          <li>
            <strong>Neon</strong> hosts our database, which holds everything listed above.
          </li>
          <li>
            <strong>DigitalOcean</strong> hosts the app servers that handle your requests.
          </li>
          <li>
            <strong>Cloudflare R2</strong> stores your photos and your data exports.
          </li>
          <li>
            <strong>Stripe</strong> handles payments. You enter card details on Stripe&rsquo;s own pages, so Stripe
            collects them directly; we receive only your payment status.
          </li>
          <li>
            <strong>Google</strong> handles sign-in, but only if you choose &ldquo;Continue with Google&rdquo;.
          </li>
          <li>
            <strong>Sentry</strong> receives error and performance reports so we can fix problems. We configure it
            not to send cookies, request headers, request bodies, URL query strings or user information. We remove
            one-time tokens from every report, and email addresses from our server&rsquo;s reports.
          </li>
          <li>
            <strong>Our email provider</strong> receives your email address and the content of each email we send
            you.
          </li>
          <li>
            <strong>OpenStreetMap Nominatim</strong> receives the location text you set (for example, a town name)
            so we can find its coordinates.
          </li>
          <li>
            <strong>Visual Crossing</strong> receives those coordinates so we can fetch weather for them. Neither service
            receives your name or email.
          </li>
          <li>
            <strong>WeatherFlow</strong> receives your station ID and token when we fetch your readings, only if
            you connect a Tempest station.
          </li>
        </List>
      </Section>

      <Section title="Cookies and browser storage">
        <P>
          Vernal sets one essential cookie. It keeps you signed in, or keeps your guest session if you
          haven&rsquo;t signed up. Your browser also stores a few interface preferences on your device, such as
          banners you&rsquo;ve dismissed, your preferred harvest units and which view you last used.
        </P>
        <P>
          We don&rsquo;t use advertising or third-party tracking cookies. Stripe sets its own cookies on its
          checkout and billing pages.
        </P>
      </Section>

      <Section title="How long we keep data">
        <List>
          <li>
            <strong>Guest data:</strong> a guest session lasts 30 days. If it isn&rsquo;t moved to an account, it is
            deleted when the session expires. Guest sessions that never saved anything are deleted after 2 days.
          </li>
          <li>
            <strong>Sign-in sessions:</strong> last 7 days. The session record is deleted 30 days after it ends.
          </li>
          <li>
            <strong>Data exports:</strong> can be downloaded for 7 days, then the file is deleted.
          </li>
          <li>
            <strong>Notifications:</strong> read notifications are deleted after 90 days.
          </li>
          <li>
            <strong>Usage events:</strong> deleted after 180 days.
          </li>
          <li>
            <strong>Email-change records:</strong> they hold email addresses, so they are deleted after 30 days.
          </li>
          <li>
            <strong>Deleting your account:</strong> deletion is scheduled for 30 days later, and you can cancel it
            until then. After that, your account and its data are removed, including your photos, exports,
            feedback, usage events and seed ratings.
          </li>
          <li>
            <strong>Payment records:</strong> Stripe keeps these under its own policy.
          </li>
        </List>
      </Section>

      <Section title="Your choices and rights">
        <List>
          <li>
            <strong>Download everything.</strong> Go to{' '}
            <Link to="/account?section=privacy" style={legalLinkStyle}>
              Account &rsaquo; Data &amp; Privacy
            </Link>{' '}
            to request an export of your data.
          </li>
          <li>
            <strong>Delete your account.</strong> In the same place.
          </li>
          <li>
            <strong>Correct your details.</strong> Change your name, email and location in{' '}
            <Link to="/account" style={legalLinkStyle}>
              Account settings
            </Link>
            .
          </li>
          <li>
            <strong>Anything else.</strong> Email <ContactLink /> and we&rsquo;ll help.
          </li>
        </List>
      </Section>

      <Section title="Security">
        <P>
          Connections to Vernal are encrypted. Passwords and one-time tokens (like password-reset links) are stored
          only as hashes. Google sign-in tokens and weather station tokens are encrypted in our database. No system
          is perfectly secure, but we work to keep your data safe and to collect only what Vernal needs.
        </P>
      </Section>

      <Section title="Children">
        <P>
          Vernal isn&rsquo;t meant for anyone under 13, and we don&rsquo;t knowingly collect their data. If you
          think a child has given us information, contact us at <ContactLink /> and we&rsquo;ll remove it.
        </P>
      </Section>

      <Section title="Changes to this policy">
        <P>
          When we change this policy, we update the date at the top. For significant changes, we&rsquo;ll also tell
          you in the app.
        </P>
      </Section>

      <Section title="Contact">
        <P>
          Questions about your data or this policy? Email <ContactLink />. See also our{' '}
          <Link to="/terms" style={legalLinkStyle}>
            Terms of Service
          </Link>
          .
        </P>
      </Section>
    </LegalPageLayout>
  );
}
