import type { ExternalServiceEnvironment } from './external-services';
import { isProductionEnv, isSmtpHostAllowed } from './external-services';

export interface SmtpEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  /** TLS implicite (port 465). Sinon STARTTLS est exigé (pas de repli clair). */
  secure: boolean;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  tls: { rejectUnauthorized: boolean; minVersion: 'TLSv1.2' };
}

export function smtpAllowsInsecure(env: ExternalServiceEnvironment = process.env): boolean {
  return !isProductionEnv(env) && env.SMTP_ALLOW_INSECURE?.trim() === 'true';
}

/**
 * Options Nodemailer : TLS vérifié, pas de downgrade.
 * - `secure: true` (souvent port 465) : TLS implicite
 * - sinon : STARTTLS obligatoire (`requireTLS`)
 * `SMTP_ALLOW_INSECURE=true` n’est honore qu’hors production (mail local).
 */
export function buildSmtpTransportOptions(
  endpoint: SmtpEndpoint,
  env: ExternalServiceEnvironment = process.env,
): SmtpTransportOptions | null {
  if (!isSmtpHostAllowed(endpoint.host, env)) return null;
  const implicitTls = endpoint.secure || endpoint.port === 465;
  const insecure = smtpAllowsInsecure(env);
  return {
    host: endpoint.host,
    port: endpoint.port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    auth: { user: endpoint.user, pass: endpoint.password },
    tls: {
      rejectUnauthorized: !insecure,
      minVersion: 'TLSv1.2',
    },
  };
}
