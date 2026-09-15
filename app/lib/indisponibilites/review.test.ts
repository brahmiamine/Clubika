import { describe, expect, it } from 'vitest';
import { applyIndispoReview, mergePersonalIndisponibilites } from './review';
import type { OfficielIndisponibilite } from '@/lib/utils/officiel-availability';

const now = new Date('2026-09-10T12:00:00.000Z');

function range(id: string, extra: Partial<OfficielIndisponibilite> = {}): OfficielIndisponibilite {
  return { id, type: 'day-range', dateStart: '01/10/2026', dateEnd: '02/10/2026', ...extra };
}

describe('mergePersonalIndisponibilites (issue #322)', () => {
  it('place une nouvelle indisponibilité en pending et ignore un statut client', () => {
    const merged = mergePersonalIndisponibilites([], [range('new', { status: 'accepted' })], now);
    expect(merged[0]).toMatchObject({ id: 'new', status: 'pending', createdAt: now.toISOString() });
  });

  it('conserve le statut d’un créneau inchangé', () => {
    const previous = [range('keep', { status: 'accepted', createdAt: '2026-09-01T00:00:00.000Z' })];
    const merged = mergePersonalIndisponibilites(previous, [range('keep')], now);
    expect(merged[0]?.status).toBe('accepted');
    expect(merged[0]?.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('remet en pending un créneau dont les dates changent', () => {
    const previous = [range('edit', { status: 'accepted', dateEnd: '02/10/2026' })];
    const merged = mergePersonalIndisponibilites(previous, [range('edit', { dateEnd: '05/10/2026' })], now);
    expect(merged[0]).toMatchObject({ status: 'pending', dateEnd: '05/10/2026' });
  });
});

describe('applyIndispoReview (issue #322)', () => {
  it('accepte, refuse avec motif, est idempotent, et refuse une seconde décision contradictoire', () => {
    const pending = [range('r1', { status: 'pending' })];
    const accepted = applyIndispoReview(pending, 'r1', 'accepted', 7, null, now);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.reviewed.status).toBe('accepted');
    expect(applyIndispoReview(accepted.items, 'r1', 'accepted', 7, null, now)).toMatchObject({ ok: true, idempotent: true });
    expect(applyIndispoReview(accepted.items, 'r1', 'rejected', 7, 'other', now)).toMatchObject({ ok: false, status: 409 });

    const rejected = applyIndispoReview(pending, 'r1', 'rejected', 7, 'schedule_too_broad', now);
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.reviewed).toMatchObject({ status: 'rejected', reviewCode: 'schedule_too_broad' });
    expect(rejected.reviewed.reviewComment).toBeUndefined();
  });
});
