import { sendEmail } from '@/lib/notifications/email';
import { isExternalServiceEnabled } from '@/lib/compliance/external-services';

export interface PasswordResetMail {
  to: string;
  subject: string;
  text: string;
}

/** Mail SMTP uniquement : le jeton va au titulaire du compte, jamais à un webhook. */
export function buildPasswordResetMail(email: string, resetUrl: string): PasswordResetMail {
  return {
    to: email,
    subject: 'Réinitialisation de votre mot de passe Clubika',
    text: `Utilisez ce lien pour choisir un nouveau mot de passe : ${resetUrl}`,
  };
}

export async function deliverPasswordResetLink(
  email: string,
  resetUrl: string,
  clubId: string,
): Promise<boolean> {
  if (!isExternalServiceEnabled('smtp')) return false;
  const mail = buildPasswordResetMail(email, resetUrl);
  return sendEmail({ ...mail, clubId });
}
