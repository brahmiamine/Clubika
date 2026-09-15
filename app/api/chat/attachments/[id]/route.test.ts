import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getChatAttachment: vi.fn(),
}));

vi.mock('@/lib/auth/require', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 7, clubId: 'club-test' } })),
}));
vi.mock('@/lib/db', () => ({ getDb: vi.fn(async () => ({})) }));
vi.mock('@/lib/auth/club-context', () => ({ setCurrentClubId: vi.fn() }));
vi.mock('@/lib/chat/service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/chat/service')>(),
  assertRoomAccess: vi.fn(async () => undefined),
}));
vi.mock('@/lib/chat/attachments', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/chat/attachments')>(),
  getChatAttachment: mocks.getChatAttachment,
}));

import { GET } from './route';

function attachmentRequest() {
  return new NextRequest('http://localhost/api/chat/attachments/attachment-1');
}

function baseAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attachment-1',
    clubId: 'club-test',
    roomId: 'room-1',
    fileName: 'file',
    sizeBytes: 7,
    uploadedByUserId: 7,
    createdAt: new Date(),
    content: Buffer.from('contenu'),
    ...overrides,
  };
}

describe('GET /api/chat/attachments/[id] Content-Disposition (issue #23)', () => {
  it('force le téléchargement d’un PDF (pas de rendu inline)', async () => {
    mocks.getChatAttachment.mockResolvedValueOnce(baseAttachment({
      kind: 'document',
      fileName: 'rapport.pdf',
      mimeType: 'application/pdf',
    }));

    const response = await GET(attachmentRequest(), { params: { id: 'attachment-1' } });

    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('forces download for a spreadsheet document (no useful inline render)', async () => {
    mocks.getChatAttachment.mockResolvedValueOnce(baseAttachment({
      kind: 'document',
      fileName: 'convocations.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));

    const response = await GET(attachmentRequest(), { params: { id: 'attachment-1' } });

    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  });

  it('keeps images inline, unaffected by the document-specific rule', async () => {
    mocks.getChatAttachment.mockResolvedValueOnce(baseAttachment({
      kind: 'image',
      fileName: 'photo.png',
      mimeType: 'image/png',
    }));

    const response = await GET(attachmentRequest(), { params: { id: 'attachment-1' } });

    expect(response.headers.get('Content-Disposition')).toMatch(/^inline;/);
  });
});
