import nodemailer from 'nodemailer';

function createTransport() {
  if (!process.env.SMTP_HOST) {
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

const transport = createTransport();

interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(opts: MailOptions): Promise<void> {
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
    console.log(`[mailer] Sent to ${opts.to}: ${info.messageId}`);
  }
}
