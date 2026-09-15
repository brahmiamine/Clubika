import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { attachChatSocketServer } from './socket-server';

const ORIGINAL_VALUE = process.env.CHAT_INSTANCE_COUNT;

function captureStdout() {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => {
    chunks.push(String(chunk));
    return original(chunk, encoding, cb);
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(''),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

describe('attachChatSocketServer — garde-fou multi-instances (issue #258 / #352)', () => {
  afterEach(() => {
    if (ORIGINAL_VALUE === undefined) delete process.env.CHAT_INSTANCE_COUNT;
    else process.env.CHAT_INSTANCE_COUNT = ORIGINAL_VALUE;
  });

  it('warns at startup when CHAT_INSTANCE_COUNT is greater than 1', () => {
    process.env.CHAT_INSTANCE_COUNT = '3';
    const capture = captureStdout();
    const httpServer = createServer();
    const handle = attachChatSocketServer(httpServer);
    try {
      expect(capture.output()).toContain('"event":"app.unhandled"');
      expect(capture.output()).toContain('CHAT_INSTANCE_COUNT=3');
    } finally {
      handle.stopSessionRevocationListener();
      handle.io.close();
      capture.restore();
    }
  });

  it('does not warn when CHAT_INSTANCE_COUNT is unset (mono-instance default)', () => {
    delete process.env.CHAT_INSTANCE_COUNT;
    const capture = captureStdout();
    const httpServer = createServer();
    const handle = attachChatSocketServer(httpServer);
    try {
      expect(capture.output()).not.toContain('CHAT_INSTANCE_COUNT');
    } finally {
      handle.stopSessionRevocationListener();
      handle.io.close();
      capture.restore();
    }
  });

  it('does not warn when CHAT_INSTANCE_COUNT is 1', () => {
    process.env.CHAT_INSTANCE_COUNT = '1';
    const capture = captureStdout();
    const httpServer = createServer();
    const handle = attachChatSocketServer(httpServer);
    try {
      expect(capture.output()).not.toContain('CHAT_INSTANCE_COUNT=1');
    } finally {
      handle.stopSessionRevocationListener();
      handle.io.close();
      capture.restore();
    }
  });
});
