import type { DataSource, QueryRunner } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import {
  assertAttachmentWithinLimits,
  assertChatUploadUsageWithinLimits,
  attachmentKindForMime,
  CHAT_UPLOAD_LIMITS,
  ChatAttachmentRateLimitError,
  ChatAttachmentValidationError,
  documentContentMatchesMime,
  documentKindFromExtension,
  withChatUploadQuota,
} from './attachments';

describe('chat attachment quotas (issue #218)', () => {
  it('rejects the sixth successful upload in a ten-second window', () => {
    const attempt = () => assertChatUploadUsageWithinLimits(
      { count: CHAT_UPLOAD_LIMITS.burstCountPerUser, bytes: 5_000 },
      { count: 5, bytes: 5_000 },
      { count: 5, bytes: 5_000 },
      1_000,
    );

    expect(attempt).toThrow(ChatAttachmentRateLimitError);
    expect(attempt).toThrow('Trop de fichiers envoyés');
  });

  it('rejects user and club hourly byte quotas before inserting the BLOB', () => {
    expect(() => assertChatUploadUsageWithinLimits(
      { count: 0, bytes: 0 },
      { count: 1, bytes: CHAT_UPLOAD_LIMITS.hourlyBytesPerUser - 100 },
      { count: 1, bytes: 1_000 },
      101,
    )).toThrow('Quota horaire de pièces jointes atteint pour votre compte');

    expect(() => assertChatUploadUsageWithinLimits(
      { count: 0, bytes: 0 },
      { count: 1, bytes: 1_000 },
      { count: 1, bytes: CHAT_UPLOAD_LIMITS.hourlyBytesPerClub - 100 },
      101,
    )).toThrow('Quota horaire de pièces jointes atteint pour le club');
  });

  it('returns an idempotent result before reading an exhausted quota (issue #268, revue Codex)', async () => {
    let transactionActive = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
      if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
      if (sql.includes('COUNT(*)')) throw new Error('quota must not be read for a duplicate');
      return [];
    });
    const runner = {
      connect: vi.fn(async () => undefined),
      query,
      startTransaction: vi.fn(async () => { transactionActive = true; }),
      commitTransaction: vi.fn(async () => { transactionActive = false; }),
      rollbackTransaction: vi.fn(async () => { transactionActive = false; }),
      release: vi.fn(async () => undefined),
      get isTransactionActive() { return transactionActive; },
    } as unknown as QueryRunner;
    const db = { createQueryRunner: () => runner } as DataSource;
    const operation = vi.fn(async () => 'created');

    const result = await withChatUploadQuota(
      db,
      { clubId: 'afp', uploadedByUserId: 42, incomingBytes: 10 },
      operation,
      async () => 'duplicate',
    );

    expect(result).toBe('duplicate');
    expect(operation).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('COUNT(*)'))).toBe(false);
  });
});

describe('document attachments — PDF/Excel/CSV (issue #265)', () => {
  it('recognizes PDF, XLSX and CSV as the "document" kind (XLS/OLE refusé, issue #23)', () => {
    expect(attachmentKindForMime('application/pdf')).toBe('document');
    expect(attachmentKindForMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('document');
    expect(attachmentKindForMime('application/vnd.ms-excel')).toBeNull();
    expect(attachmentKindForMime('text/csv')).toBe('document');
  });

  it('still rejects unsupported document types (e.g. Word, generic octet-stream)', () => {
    expect(attachmentKindForMime('application/msword')).toBeNull();
    expect(attachmentKindForMime('application/octet-stream')).toBeNull();
  });

  it('does not regress existing image/gif/video/audio detection', () => {
    expect(attachmentKindForMime('image/png')).toBe('image');
    expect(attachmentKindForMime('image/gif')).toBe('gif');
    expect(attachmentKindForMime('video/mp4')).toBe('video');
    expect(attachmentKindForMime('audio/mpeg')).toBe('audio');
  });

  it('accepts a document within the 20 Mo limit and rejects one above it', () => {
    expect(() => assertAttachmentWithinLimits('document', 19 * 1024 * 1024)).not.toThrow();
    expect(() => assertAttachmentWithinLimits('document', 21 * 1024 * 1024)).toThrow(ChatAttachmentValidationError);
  });
});

describe('document content verification (issue #265, revue Codex)', () => {
  it('accepts a PDF whose bytes start with the %PDF- signature, rejects one that does not', () => {
    expect(documentContentMatchesMime('application/pdf', Buffer.from('%PDF-1.7\n…'))).toBe(true);
    expect(documentContentMatchesMime('application/pdf', Buffer.from('MZ\x90\x00 not a pdf'))).toBe(false);
  });

  it('accepts an XLSX whose bytes are a real OOXML package, rejects a mere ZIP signature', () => {
    expect(documentContentMatchesMime(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
    )).toBe(false);
  });

  it('rejects legacy XLS/OLE (issue #23, non inspectable)', () => {
    expect(documentContentMatchesMime(
      'application/vnd.ms-excel',
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]),
    )).toBe(false);
  });

  it('accepts CSV-like plain text, rejects binary content disguised as CSV', () => {
    expect(documentContentMatchesMime('text/csv', Buffer.from('nom,role\nAlice,admin\n'))).toBe(true);
    // Octet nul : signature classique d'un binaire (ex. exécutable) déguisé en .csv.
    expect(documentContentMatchesMime('text/csv', Buffer.from([0x4d, 0x5a, 0x00, 0x90, 0x00, 0x03]))).toBe(false);
  });

  it('rejects a message whose claimed kind the content plainly is not, even for an unrelated mime string', () => {
    expect(documentContentMatchesMime('application/json', Buffer.from('{}'))).toBe(false);
  });

  it('falls back to the file extension only when the content also confirms it (e.g. CSV reported as text/plain)', () => {
    const csvBytes = Buffer.from('nom,role\nAlice,admin\n');
    expect(documentKindFromExtension('export.csv', csvBytes)).toEqual({ mimeType: 'text/csv' });
    // L'extension seule ne suffit jamais : un exécutable renommé en .csv est rejeté.
    expect(documentKindFromExtension('malware.csv', Buffer.from([0x4d, 0x5a, 0x00, 0x90]))).toBeNull();
    expect(documentKindFromExtension('archive.zip', csvBytes)).toBeNull();
  });
});
