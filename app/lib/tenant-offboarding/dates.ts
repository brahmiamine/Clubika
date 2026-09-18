import { MAX_RETENTION_DAYS } from './constants';
import { OffboardingError } from './errors';

export function parseRetentionUntil(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new OffboardingError('retentionUntil invalide', 400);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new OffboardingError('retentionUntil invalide', 400);
  }
  const max = Date.now() + MAX_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  if (date.getTime() > max) {
    throw new OffboardingError('retentionUntil trop lointaine (paramètre produit, pas un délai légal)', 400);
  }
  return date;
}
