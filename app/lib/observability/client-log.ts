'use client';

import type { LogEventId } from './events';

/**
 * Client sink: production is silent. Development only records the allowlisted
 * event id — never names, API bodies, or Error objects.
 */
export function logError(event: LogEventId, ...details: unknown[]): void {
  if (process.env.NODE_ENV === 'production') return;
  void event;
  void details;
}

export function logWarn(event: LogEventId, ...details: unknown[]): void {
  if (process.env.NODE_ENV === 'production') return;
  void event;
  void details;
}

export function logInfo(event: LogEventId, ...details: unknown[]): void {
  if (process.env.NODE_ENV === 'production') return;
  void event;
  void details;
}
