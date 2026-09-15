/**
 * Migration 0025 (issue #32) — comptes privilégiés : MFA plateforme, preuves
 * d'authentification récente, journal minimal, invitations émises par la
 * plateforme (createdByUserId nullable).
 *
 * Idempotente : ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
 * Le backfill `authenticatedAt = createdAt` ne touche que les lignes encore
 * NULL. Aucune donnée personnelle en clair dans le journal.
 */
