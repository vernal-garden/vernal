import { Link } from 'react-router-dom';
import LegalPageLayout, { ContactLink, List, P, Section, legalLinkStyle } from '../components/legal/LegalPageLayout';
import { GOVERNING_STATE, OPERATOR_NAME } from '../lib/legal';

export default function TermsPage() {
  return (
    <LegalPageLayout title="Terms of Service" testId="terms-page">
      <P>
        These terms cover your use of Vernal, the garden-planning service at vernal.garden, run by {OPERATOR_NAME}{' '}
        in {GOVERNING_STATE}, USA. &ldquo;We&rdquo; and &ldquo;us&rdquo; mean the people who run Vernal;
        &ldquo;you&rdquo; means you.
      </P>

      <Section title="Agreeing to these terms">
        <P>
          By using Vernal, as a guest or with an account, you agree to these terms. Our{' '}
          <Link to="/privacy" style={legalLinkStyle}>
            Privacy Policy
          </Link>{' '}
          explains how we handle your data and is part of this agreement.
        </P>
      </Section>

      <Section title="Who can use Vernal">
        <P>You must be at least 13 years old to use Vernal.</P>
      </Section>

      <Section title="Your account">
        <List>
          <li>Keep your password safe, and don&rsquo;t share your account.</li>
          <li>Use an email address you can receive mail at, and keep it up to date.</li>
          <li>You&rsquo;re responsible for what happens under your account.</li>
          <li>
            If you think someone else has used your account, change your password and tell us at <ContactLink />.
          </li>
        </List>
      </Section>

      <Section title="Acceptable use">
        <P>Please don&rsquo;t:</P>
        <List>
          <li>use Vernal to break the law or to harass or abuse anyone;</li>
          <li>scrape Vernal, or send so many requests that it slows down for others;</li>
          <li>try to break into, disrupt or get around the security of the service or other people&rsquo;s accounts;</li>
          <li>
            upload anything you don&rsquo;t have the right to share, or anything illegal, hateful or abusive.
          </li>
        </List>
      </Section>

      <Section title="Your content">
        <P>
          You own what you put into Vernal: your gardens, seeds, records, notes and photos. You give us permission
          to store, process and display that content only as needed to run the service for you, for example to show
          it to you, back it up and include it in your exports.
        </P>
        <P>
          When you submit a seed or a correction to the community seed catalogue, or rate a catalogue seed, you
          also let us use it to build and improve the catalogue for everyone. Ratings are shown as part of each
          seed&rsquo;s average.
        </P>
        <P>
          If you delete your account, your ratings are deleted and the seeds you submitted are deleted with your
          other data. Corrections you sent stay in our review records without your name. Any change we&rsquo;ve
          already made to the community catalogue because of your submission or correction stays in the catalogue,
          without your name attached.
        </P>
      </Section>

      <Section title="Plans and payment">
        <P>
          Vernal has a free plan and a paid Supporter plan. Supporter is available monthly, annually, or as a
          one-time lifetime purchase. Payments are handled by Stripe.
        </P>
        <List>
          <li>
            Monthly and annual plans renew automatically until you cancel. You can cancel at any time in Account
            settings, and you keep Supporter features until the end of the period you&rsquo;ve paid for.
          </li>
          <li>
            Lifetime is a single payment. It gives you Supporter features for as long as we run the hosted
            service, with no renewals.
          </li>
          <li>
            {/* REVIEW: refund policy placeholder — confirm before launch */}
            Contact us within 14 days of a charge and we&rsquo;ll review refund requests.
          </li>
        </List>
      </Section>

      <Section title="Open source">
        <P>
          Vernal&rsquo;s code is open source under the GNU Affero General Public License v3. The source code and
          the full licence are linked from the About page. The licence covers the code; these terms cover your use
          of the hosted service at vernal.garden.
        </P>
      </Section>

      <Section title="Gardening information">
        <P>
          Frost dates, planting windows, weather and the community seed catalogue are estimates, and some of the
          catalogue is contributed by other gardeners. Local conditions vary. Use Vernal as a guide alongside your
          own judgement; we can&rsquo;t promise any particular result in your garden.
        </P>
      </Section>

      <Section title="Changes to the service">
        <P>
          We keep working on Vernal, so features may be added, changed or removed. We may also pause the service
          from time to time for maintenance or to fix problems.
        </P>
      </Section>

      <Section title="Ending your account">
        <P>
          You can delete your account at any time from{' '}
          <Link to="/account?section=privacy" style={legalLinkStyle}>
            Account &rsaquo; Data &amp; Privacy
          </Link>
          . Deletion happens 30 days later, and you can cancel it until then. We may suspend or close accounts
          that break these terms.
        </P>
      </Section>

      <Section title="Disclaimers">
        <P>
          Vernal is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent the law allows, we
          make no warranties about it, including that it will always be available, error-free, or fit for a
          particular purpose.
        </P>
      </Section>

      <Section title="Limitation of liability">
        <P>
          To the extent the law allows, we aren&rsquo;t liable for indirect or consequential losses, such as lost
          crops, lost data or lost profits. Our total liability for any claim relating to Vernal is limited to the
          amount you paid us in the 12 months before the claim.
        </P>
      </Section>

      <Section title="Governing law">
        <P>These terms are governed by the laws of {GOVERNING_STATE}, USA.</P>
      </Section>

      <Section title="Changes to these terms">
        <P>
          When we change these terms, we update the date at the top. If you keep using Vernal after a change, you
          agree to the updated terms. For significant changes, we&rsquo;ll also tell you in the app.
        </P>
      </Section>

      <Section title="Contact">
        <P>
          Questions about these terms? Email <ContactLink />.
        </P>
      </Section>
    </LegalPageLayout>
  );
}
