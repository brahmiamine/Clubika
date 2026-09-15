import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AttachmentRejectedError, inspectAttachment } from './file-inspect';

function storedZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length + file.data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    file.data.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function ooxml(kind: 'xlsx' | 'docx', extra: Array<{ name: string; data: Buffer }> = []): Buffer {
  const prefix = kind === 'xlsx' ? 'xl/workbook.xml' : 'word/document.xml';
  return storedZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    },
    { name: prefix, data: Buffer.from('<root/>') },
    ...extra,
  ]);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

describe('inspectAttachment (issue #23)', () => {
  it('accepte un PNG dont l’extension, la MIME et la signature concordent', () => {
    const result = inspectAttachment({
      usage: 'chat',
      fileName: 'photo.png',
      declaredMime: 'image/png',
      content: PNG,
    });
    expect(result.canonicalMime).toBe('image/png');
    expect(result.kind).toBe('image');
  });

  it('refuse un MIME falsifié (PNG annoncé comme JPEG)', () => {
    expect(() => inspectAttachment({
      usage: 'chat',
      fileName: 'photo.jpg',
      declaredMime: 'image/jpeg',
      content: PNG,
    })).toThrow(AttachmentRejectedError);
  });

  it('refuse EICAR même présenté comme CSV', () => {
    expect(() => inspectAttachment({
      usage: 'chat',
      fileName: 'test.csv',
      declaredMime: 'text/csv',
      content: EICAR,
    })).toThrow(AttachmentRejectedError);
  });

  it('refuse un exécutable PE déguisé (MZ)', () => {
    expect(() => inspectAttachment({
      usage: 'chat',
      fileName: 'ok.csv',
      declaredMime: 'text/csv',
      content: Buffer.from([0x4d, 0x5a, 0x00, 0x90]),
    })).toThrow(AttachmentRejectedError);
  });

  it('refuse un XLSX qui n’est qu’une signature ZIP sans OOXML', () => {
    expect(() => inspectAttachment({
      usage: 'chat',
      fileName: 'sheet.xlsx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
    })).toThrow(AttachmentRejectedError);
  });

  it('accepte un XLSX OOXML sans macro', () => {
    const result = inspectAttachment({
      usage: 'chat',
      fileName: 'convocations.xlsx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: ooxml('xlsx'),
    });
    expect(result.format).toBe('xlsx');
  });

  it('refuse un DOCX/XLSX avec vbaProject.bin', () => {
    expect(() => inspectAttachment({
      usage: 'planning',
      fileName: 'macro.docx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: ooxml('docx', [{ name: 'word/vbaProject.bin', data: Buffer.from('macro') }]),
    })).toThrow(AttachmentRejectedError);
  });

  it('refuse une bombe ZIP (ratio de décompression)', () => {
    const name = Buffer.from('xl/workbook.xml');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(10, 18);
    local.writeUInt32LE(20_000_000, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const padded = Buffer.concat([local, Buffer.alloc(10)]);
    expect(() => inspectAttachment({
      usage: 'chat',
      fileName: 'bomb.xlsx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: padded,
    })).toThrow(AttachmentRejectedError);
  });

  it('refuse un polyglotte HTML annoncé comme PDF', () => {
    expect(() => inspectAttachment({
      usage: 'chat',
      fileName: 'doc.pdf',
      declaredMime: 'application/pdf',
      content: Buffer.from('<!DOCTYPE html><html><body>x</body></html>'),
    })).toThrow(AttachmentRejectedError);
  });

  it('refuse le XLS/OLE (non inspectable de façon fiable)', () => {
    expect(() => inspectAttachment({
      usage: 'chat',
      fileName: 'ancien.xls',
      declaredMime: 'application/vnd.ms-excel',
      content: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]),
    })).toThrow(AttachmentRejectedError);
  });

  it('refuse un type chat hors allowlist planning (gif)', () => {
    expect(() => inspectAttachment({
      usage: 'planning',
      fileName: 'anim.gif',
      declaredMime: 'image/gif',
      content: Buffer.from('GIF89a\x01\x00\x01\x00'),
    })).toThrow(AttachmentRejectedError);
  });
});
