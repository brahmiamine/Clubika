/**
 * Inspection unique des pièces jointes (issue #23) : extension, MIME déclaré,
 * magic bytes et structure interne doivent concorder. Types non analysables
 * (XLS/OLE, archives chiffrées, macros) refusés. Quarantaine = verdict en
 * mémoire puis INSERT seulement si propre (jamais lisible avant promotion).
 */

export type AttachmentUsage = 'chat' | 'planning';

export type DetectedFormat =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'gif'
  | 'pdf'
  | 'csv'
  | 'txt'
  | 'xlsx'
  | 'docx'
  | 'mp4'
  | 'webm'
  | 'mpeg-audio'
  | 'ogg'
  | 'wav'
  | 'm4a';

export class AttachmentRejectedError extends Error {
  constructor(message = 'Type de fichier non autorisé') {
    super(message);
    this.name = 'AttachmentRejectedError';
  }
}

const GENERIC_MIMES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-download',
]);

const FORMAT_SPEC: Record<DetectedFormat, { mime: string; extensions: readonly string[]; chat: boolean; planning: boolean }> = {
  jpeg: { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'], chat: true, planning: true },
  png: { mime: 'image/png', extensions: ['png'], chat: true, planning: true },
  webp: { mime: 'image/webp', extensions: ['webp'], chat: true, planning: true },
  gif: { mime: 'image/gif', extensions: ['gif'], chat: true, planning: false },
  pdf: { mime: 'application/pdf', extensions: ['pdf'], chat: true, planning: true },
  csv: { mime: 'text/csv', extensions: ['csv'], chat: true, planning: true },
  txt: { mime: 'text/plain', extensions: ['txt'], chat: false, planning: true },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
    chat: true,
    planning: true,
  },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    chat: false,
    planning: true,
  },
  mp4: { mime: 'video/mp4', extensions: ['mp4'], chat: true, planning: false },
  webm: { mime: 'video/webm', extensions: ['webm'], chat: true, planning: false },
  'mpeg-audio': { mime: 'audio/mpeg', extensions: ['mp3'], chat: true, planning: false },
  ogg: { mime: 'audio/ogg', extensions: ['ogg', 'oga'], chat: true, planning: false },
  wav: { mime: 'audio/wav', extensions: ['wav'], chat: true, planning: false },
  m4a: { mime: 'audio/mp4', extensions: ['m4a'], chat: true, planning: false },
};

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const MAX_ZIP_ENTRIES = 64;
const MAX_ZIP_UNCOMPRESSED = 32 * 1024 * 1024;
const MAX_ZIP_RATIO = 50;
const MAX_ZIP_ENTRY_UNCOMPRESSED = 16 * 1024 * 1024;

export function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0]!.trim().toLowerCase();
}

export function safeFileName(value: string): string {
  const base = value.split(/[/\\]/).pop() || 'document';
  return base.replace(/[\0\r\n]/g, '_').replace(/[^\p{L}\p{N}._() -]/gu, '_').slice(0, 180) || 'document';
}

function looksLikeText(content: Buffer): boolean {
  if (content.length === 0) return false;
  const sample = content.subarray(0, Math.min(content.length, 8_192));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0x00) return false;
    const isAllowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (!isAllowedWhitespace && byte < 0x20) controlBytes += 1;
  }
  return controlBytes / sample.length < 0.01;
}

function startsWith(content: Buffer, signature: number[] | string): boolean {
  const bytes = typeof signature === 'string' ? Buffer.from(signature, 'latin1') : Buffer.from(signature);
  return content.length >= bytes.length && content.subarray(0, bytes.length).equals(bytes);
}

function detectFormat(content: Buffer): DetectedFormat | null {
  if (startsWith(content, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (content.length >= 12 && content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  if (startsWith(content, 'GIF87a') || startsWith(content, 'GIF89a')) return 'gif';
  if (startsWith(content, '%PDF-')) return 'pdf';
  if (startsWith(content, [0x50, 0x4b, 0x03, 0x04])) return null; // ZIP : distingué plus bas (xlsx/docx)
  if (content.length >= 12 && content.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = content.subarray(8, 12).toString('ascii');
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'm4a';
    return 'mp4';
  }
  if (startsWith(content, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (startsWith(content, 'OggS')) return 'ogg';
  if (content.length >= 12 && content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WAVE') {
    return 'wav';
  }
  if (startsWith(content, 'ID3') || (content.length >= 2 && content[0] === 0xff && (content[1]! & 0xe0) === 0xe0)) {
    return 'mpeg-audio';
  }
  if (looksLikeText(content)) {
    const head = content.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return null;
    return 'csv';
  }
  return null;
}

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

function parseStoredZip(content: Buffer): ZipEntry[] | null {
  if (!startsWith(content, [0x50, 0x4b, 0x03, 0x04])) return null;
  const entries: ZipEntry[] = [];
  let offset = 0;
  let totalUncompressed = 0;
  while (offset + 30 <= content.length) {
    const sig = content.readUInt32LE(offset);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) return null;
    if (entries.length >= MAX_ZIP_ENTRIES) return null;
    const flags = content.readUInt16LE(offset + 6);
    const compressedSize = content.readUInt32LE(offset + 18);
    const uncompressedSize = content.readUInt32LE(offset + 22);
    const nameLen = content.readUInt16LE(offset + 26);
    const extraLen = content.readUInt16LE(offset + 28);
    if (flags & 0x1) return null;
    if (flags & 0x8) return null;
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compressedSize > content.length) return null;
    const name = content.subarray(nameStart, nameStart + nameLen).toString('utf8');
    if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED) return null;
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_ZIP_RATIO) return null;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED) return null;
    entries.push({ name, compressedSize, uncompressedSize });
    offset = dataStart + compressedSize;
  }
  return entries.length > 0 ? entries : null;
}

const OOXML_FORBIDDEN = [
  /vbaProject\.bin$/i,
  /vbaData\.xml$/i,
  /macrosheets\//i,
  /\/embeddings\//i,
  /oleObject/i,
  /activeX/i,
  /\.exe$/i,
  /\.js$/i,
  /\.vbs$/i,
  /\.bat$/i,
  /\.cmd$/i,
  /\.dll$/i,
  /\.zip$/i,
];

function inspectOoxml(content: Buffer, expected: 'xlsx' | 'docx'): boolean {
  const entries = parseStoredZip(content);
  if (!entries) return false;
  const names = entries.map((entry) => entry.name.replace(/\\/g, '/'));
  if (!names.some((name) => name === '[Content_Types].xml')) return false;
  if (names.some((name) => OOXML_FORBIDDEN.some((pattern) => pattern.test(name)))) return false;
  if (expected === 'xlsx') return names.some((name) => name.startsWith('xl/'));
  return names.some((name) => name.startsWith('word/'));
}

function containsEicar(content: Buffer): boolean {
  return content.includes(EICAR) || content.toString('latin1').includes(EICAR);
}

function looksLikeExecutable(content: Buffer): boolean {
  return startsWith(content, 'MZ') || startsWith(content, [0x7f, 0x45, 0x4c, 0x46]);
}

export interface InspectedAttachment {
  format: DetectedFormat;
  canonicalMime: string;
  safeName: string;
  kind: 'image' | 'gif' | 'video' | 'audio' | 'document';
}

function chatKind(format: DetectedFormat): InspectedAttachment['kind'] {
  if (format === 'gif') return 'gif';
  if (format === 'jpeg' || format === 'png' || format === 'webp') return 'image';
  if (format === 'mp4' || format === 'webm') return 'video';
  if (format === 'mpeg-audio' || format === 'ogg' || format === 'wav' || format === 'm4a') return 'audio';
  return 'document';
}

function resolveZipFormat(content: Buffer, extension: string, declared: string): DetectedFormat | null {
  if (inspectOoxml(content, 'xlsx') && (extension === 'xlsx' || declared.includes('spreadsheetml') || declared === '' || GENERIC_MIMES.has(declared))) {
    if (extension && extension !== 'xlsx') return null;
    return 'xlsx';
  }
  if (inspectOoxml(content, 'docx') && (extension === 'docx' || declared.includes('wordprocessingml') || declared === '' || GENERIC_MIMES.has(declared))) {
    if (extension && extension !== 'docx') return null;
    return 'docx';
  }
  return null;
}

/**
 * Fail-closed : le fichier n’est jamais considéré propre si un signal diverge.
 */
export function inspectAttachment(input: {
  usage: AttachmentUsage;
  fileName: string;
  declaredMime: string;
  content: Buffer;
}): InspectedAttachment {
  if (input.content.length === 0) throw new AttachmentRejectedError();
  if (containsEicar(input.content) || looksLikeExecutable(input.content)) {
    throw new AttachmentRejectedError();
  }

  const name = safeFileName(input.fileName);
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  const declared = normalizeMimeType(input.declaredMime);
  const genericDeclared = GENERIC_MIMES.has(declared) || declared === 'text/plain';

  let format = detectFormat(input.content);
  if (startsWith(input.content, [0x50, 0x4b, 0x03, 0x04])) {
    format = resolveZipFormat(input.content, extension, genericDeclared ? '' : declared);
  }
  if (format === 'csv' && extension === 'txt' && input.usage === 'planning') {
    format = 'txt';
  }
  if (format === 'csv' && extension && extension !== 'csv' && extension !== 'txt') {
    throw new AttachmentRejectedError();
  }
  if (!format) throw new AttachmentRejectedError();

  if (format === 'webm' && declared === 'audio/webm') {
    if (input.usage !== 'chat') throw new AttachmentRejectedError();
    if (extension && extension !== 'webm') throw new AttachmentRejectedError();
    return { format, canonicalMime: 'audio/webm', safeName: name, kind: 'audio' };
  }

  const spec = FORMAT_SPEC[format];
  if (input.usage === 'chat' && !spec.chat) throw new AttachmentRejectedError();
  if (input.usage === 'planning' && !spec.planning) throw new AttachmentRejectedError();

  if (extension && !spec.extensions.includes(extension)) throw new AttachmentRejectedError();
  if (!genericDeclared && declared !== spec.mime) {
    if (!(format === 'm4a' && (declared === 'audio/m4a' || declared === 'audio/x-m4a'))) {
      if (!(format === 'wav' && declared === 'audio/x-wav')) {
        if (!(format === 'mpeg-audio' && (declared === 'audio/mp3' || declared === 'audio/mpeg'))) {
          throw new AttachmentRejectedError();
        }
      }
    }
  }

  if (format === 'pdf') {
    const haystack = input.content.subarray(0, Math.min(input.content.length, 512 * 1024)).toString('latin1');
    if (/\/JavaScript\b/i.test(haystack) || /\/Launch\b/.test(haystack) || /\/EmbeddedFile\b/.test(haystack)) {
      throw new AttachmentRejectedError();
    }
  }

  return {
    format,
    canonicalMime: spec.mime,
    safeName: name,
    kind: chatKind(format),
  };
}
