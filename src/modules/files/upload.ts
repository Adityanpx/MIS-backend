import type { RequestHandler } from 'express';
import multer from 'multer';
import { fromBuffer } from 'file-type';
import { badRequest, unprocessable } from '../../lib/errors';

export type AllowedKind = 'png' | 'jpg' | 'svg' | 'pdf';
const MIME: Record<AllowedKind, string> = {
  png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', pdf: 'application/pdf',
};

/** Accepts exactly one file in field `field`, kept in memory, max `maxBytes`. */
export function uploadSingle(field: string, maxBytes: number): RequestHandler {
  return multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 10 } }).single(field);
}

/** SVG is text, so magic bytes can't identify it: accept only clean SVG markup (no scripts or event handlers). */
function isSafeSvg(buf: Buffer): boolean {
  const s = buf.toString('utf8');
  const head = s.trimStart().slice(0, 300).toLowerCase();
  const looksSvg = head.startsWith('<svg') || (head.startsWith('<?xml') && s.toLowerCase().includes('<svg'));
  return looksSvg && !/<script|javascript:|\son[a-z]+\s*=|<foreignobject|<!entity|<iframe|<embed|<object/i.test(s);
}

/** Identifies the real file type from its content (never trust the extension or the browser's MIME type). */
export async function detectFile(
  file: Express.Multer.File | undefined,
  allowed: AllowedKind[],
): Promise<{ ext: AllowedKind; mime: string; buffer: Buffer }> {
  if (!file || file.size === 0) throw badRequest('FILE_REQUIRED', 'Please attach a file.');
  const ft = await fromBuffer(file.buffer);
  let ext: AllowedKind | undefined;
  if (ft?.ext === 'png') ext = 'png';
  else if (ft?.ext === 'jpg') ext = 'jpg';
  else if (ft?.ext === 'pdf') ext = 'pdf';
  else if (!ft && allowed.includes('svg') && isSafeSvg(file.buffer)) ext = 'svg';
  if (!ext || !allowed.includes(ext)) {
    throw unprocessable('FILE_TYPE_NOT_ALLOWED', `Allowed file types: ${allowed.join(', ').toUpperCase()}.`);
  }
  return { ext, mime: MIME[ext], buffer: file.buffer };
}
