import { logError, logWarnForClub } from '@/lib/observability/log';
import nodemailer, { type Transporter } from 'nodemailer';
import { getDb } from '@/lib/db';
import { readAppSettings, getSmtpPassword } from '@/lib/settings-store';
import { buildSmtpTransportOptions } from '@/lib/compliance/smtp-tls';
import { isExternalServiceEnabled } from '@/lib/compliance/external-services';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  clubId: string;
}

const transporterCache = new Map<string, { transporter: Transporter | null; from: string | null }>();

function buildEnvTransporter(): { transporter: Transporter | null; from: string | null } {
  if (!isExternalServiceEnabled('smtp')) {
    return { transporter: null, from: null };
  }
  const host = process.env.SMTP_HOST?.trim();
  const port = Number.parseInt(process.env.SMTP_PORT || '', 10);
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  const secure = process.env.SMTP_SECURE === 'true';

  if (!host || !Number.isFinite(port) || !user || !password) {
    return { transporter: null, from: null };
  }

  const options = buildSmtpTransportOptions({ host, port, user, password, secure });
  if (!options) return { transporter: null, from: null };

  return {
    transporter: nodemailer.createTransport(options),
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

  if (isExternalServiceEnabled('smtp') && smtp.host && smtp.port && smtp.user && smtp.passwordSet) {
    const password = await getSmtpPassword(db, clubId);
    const options = password
      ? buildSmtpTransportOptions({
        host: smtp.host,
        port: smtp.port,
        user: smtp.user,
        password,
        secure: smtp.secure,
      })
      : null;
    resolved = options
      ? {
        transporter: nodemailer.createTransport(options),
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

export async function sendEmail(message: EmailMessage): Promise<boolean> {
  if (!isExternalServiceEnabled('smtp')) return false;
  const { transporter, from } = await getTransporterForClub(message.clubId);
  if (!transporter) return false;

  try {
    await transporter.sendMail({
      from: from ?? undefined,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return true;
  } catch (error) {
    logError('smtp.send_failed', error);
    return false;
  }
}
