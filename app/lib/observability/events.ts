export const LOG_EVENTS = [
  'app.unhandled',
  'smtp.send_failed',
  'smtp.unconfigured',
  'push.delivery_failed',
  'whatsapp.delivery_failed',
  'auth.failed',
  'crypto.decrypt_failed',
  'outbox.last_error_purged',
  'observability.write_failed',
] as const;

export type LogEventId = (typeof LOG_EVENTS)[number];
export type LogLevel = 'error' | 'warn' | 'info';
