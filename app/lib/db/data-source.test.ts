import { describe, expect, it } from 'vitest';
import { MARIADB_CONNECTOR_PACKAGE, mariadbPoolExtra, shouldSynchronizeSchema } from './data-source';

describe('shouldSynchronizeSchema (issue #283)', () => {
  it('never enables synchronize in production, even with the opt-in flag', () => {
    expect(shouldSynchronizeSchema({ NODE_ENV: 'production', TYPEORM_SYNCHRONIZE: '1' })).toBe(false);
    expect(shouldSynchronizeSchema({ NODE_ENV: 'production' })).toBe(false);
  });

  it('stays off by default outside production', () => {
    expect(shouldSynchronizeSchema({ NODE_ENV: 'test' })).toBe(false);
    expect(shouldSynchronizeSchema({ NODE_ENV: 'development' })).toBe(false);
    expect(shouldSynchronizeSchema({})).toBe(false);
  });

  it('allows an explicit local/test opt-in only', () => {
    expect(shouldSynchronizeSchema({ NODE_ENV: 'development', TYPEORM_SYNCHRONIZE: '1' })).toBe(true);
    expect(shouldSynchronizeSchema({ NODE_ENV: 'test', TYPEORM_SYNCHRONIZE: '1' })).toBe(true);
  });
});

describe('mariadbPoolExtra', () => {
  it('utilise un pool mysql2 (évite PROTOCOL_INCORRECT_PACKET_SEQUENCE)', () => {
    expect(MARIADB_CONNECTOR_PACKAGE).toBe('mysql2');
    expect(mariadbPoolExtra()).toEqual({ connectionLimit: 10, enableKeepAlive: true });
  });
});
