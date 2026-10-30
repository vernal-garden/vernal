import nodemailer from 'nodemailer';
import { logger } from './logger';
import { isMailEnabled } from './serverConfig';

type Transport = ReturnType<typeof nodemailer.createTransport>;

function createTransport(): Transport {
  if (!process.env.SMTP_HOST) {
    // Without this, production mail would go to jsonTransport: nothing sent,
    // and the dev printout below would log reset links.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP_HOST must be set in production');
    }
    // Development fallback — log emails to the console
    return nodemailer.createTransport({ jsonTransport: true });
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? '465', 10),
    secure: parseInt(process.env.SMTP_PORT ?? '465', 10) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// Built on the first send, so a server with mail off never needs SMTP settings.
let transport: Transport | null = null;

interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// The part after the last @, so logs never hold a full address.
function recipientDomain(to: string): string {
  const at = to.lastIndexOf('@');
  return at >= 0 && at < to.length - 1 ? to.slice(at + 1).toLowerCase() : 'unknown';
}

export { isMailEnabled };

export async function sendMail(opts: MailOptions): Promise<void> {
  if (!isMailEnabled()) {
    // No address, domain, subject or body: nothing about the message.
    logger.info('mail off: message skipped');
    return;
  }

  transport ??= createTransport();
  const info = await transport.sendMail({
    from: process.env.SMTP_FROM ?? 'Vernal <noreply@vernal.garden>',
    ...opts,
  });

  // In development (jsonTransport), log the message so you can read the reset link
  if (!process.env.SMTP_HOST) {
    console.log('[mailer] Email (dev mode — not sent):');
    console.log(`  To: ${opts.to}`);
    console.log(`  Subject: ${opts.subject}`);
    console.log(`  Text: ${opts.text}`);
  } else {
    logger.info('Email sent', { recipientDomain: recipientDomain(opts.to), messageId: info.messageId });
  }
}
