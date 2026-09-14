import { logError, logWarnForClub } from '@/lib/observability/log';
import nodemailer, { type Transporter } from 'nodemailer';
import { getDb } from '@/lib/db';
import { readAppSettings, getSmtpPassword } from '@/lib/settings-store';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  clubId: string;
}

const transporterCache = new Map<string, { transporter: Transporter | null; from: string | null }>();

function buildEnvTransporter(): { transporter: Transporter | null; from: string | null } {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number.parseInt(process.env.SMTP_PORT || '', 10);
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;

  if (!host || !Number.isFinite(port) || !user || !password) {
    return { transporter: null, from: null };
  }

  return {
    transporter: nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user, pass: password },
    }),
    from: process.env.SMTP_FROM?.trim() || user,
  };
}

async function getTransporterForClub(clubId: string): Promise<{ transporter: Transporter | null; from: string | null }> {
  const cached = transporterCache.get(clubId);
  if (cached) return cached;

  const db = await getDb();
  const settings = await readAppSettings(db, clubId);
  const smtp = settings.smtp;
  let resolved: { transporter: Transporter | null; from: string | null };

  if (smtp.host && smtp.port && smtp.user && smtp.passwordSet) {
    const password = await getSmtpPassword(db, clubId);
    resolved = password
      ? {
        transporter: nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: { user: smtp.user, pass: password },
        }),
        from: smtp.fromName ? `${smtp.fromName} <${smtp.fromEmail || smtp.user}>` : (smtp.fromEmail || smtp.user),
      }
      : buildEnvTransporter();
  } else {
    resolved = buildEnvTransporter();
  }

  if (!resolved.transporter) {
    logWarnForClub('smtp.unconfigured', clubId);
  }
  transporterCache.set(clubId, resolved);
  return resolved;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const { transporter, from } = await getTransporterForClub(message.clubId);
  if (!transporter) return;

  try {
    await transporter.sendMail({
      from: from ?? undefined,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  } catch (error) {
    logError('smtp.send_failed', error);
  }
}
