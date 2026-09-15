import { describe, expect, it } from 'vitest';
import { classificationIds, DATA_CLASSIFICATION } from './classification';

describe('classification des données (issue #24)', () => {
  it('couvre secrets, capacités, contenu, BLOB, push, audit et sauvegardes', () => {
    const ids = classificationIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'app-encryption-key',
      'session-tokens',
      'chat-smtp',
      'attachments',
      'push',
      'audit',
      'backups',
    ]));
    expect(DATA_CLASSIFICATION.every((entry) => entry.atRest.length > 10)).toBe(true);
  });
});
