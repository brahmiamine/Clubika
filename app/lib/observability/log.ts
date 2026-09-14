import { createHash, randomUUID } from 'node:crypto';
import { LOG_EVENTS, type LogEventId, type LogLevel } from './events';
import { redact } from './redact';

export { LOG_EVENTS, type LogEventId, type LogLevel };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: LogEventId;
  correlationId: string;
  tenant?: string;
  details?: unknown;
}

function pseudonymTenant(clubId: string | undefined): string | undefined {
  if (!clubId) return undefined;
  return createHash('sha256').update(clubId).digest('hex').slice(0, 12);
}

function write(level: LogLevel, event: LogEventId, details: unknown[], clubId?: string): void {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    event,
    correlationId: randomUUID(),
    tenant: pseudonymTenant(clubId),
    details: details.length ? redact(details.length === 1 ? details[0] : details) : undefined,
  };
  const line = `${JSON.stringify(record)}\n`;
  const stream = level === 'error' ? process.stderr : process.stdout;
  try {
    stream.write(line);
  } catch {
    // Last-resort: never throw from logging, never use console.* here.
  }
}

export function logError(event: LogEventId, ...details: unknown[]): void {
  write('error', event, details);
}

export function logWarn(event: LogEventId, ...details: unknown[]): void {
  write('warn', event, details);
}

export function logInfo(event: LogEventId, ...details: unknown[]): void {
  write('info', event, details);
}

export function logErrorForClub(event: LogEventId, clubId: string, ...details: unknown[]): void {
  write('error', event, details, clubId);
}

export function logWarnForClub(event: LogEventId, clubId: string, ...details: unknown[]): void {
  write('warn', event, details, clubId);
}
