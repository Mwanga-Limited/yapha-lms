/** Does the start of a file match the type it claims to be? (The browser's declared type alone proves nothing.) */
const starts = (b, sig, at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

export const HEAD_BYTES = 16;

export function contentMatches(mime, head) {
  const b = Buffer.from(head);
  if (mime === 'image/png') return starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === 'image/jpeg' || mime === 'image/jpg') return starts(b, [0xff, 0xd8, 0xff]);
  if (mime === 'image/gif') return starts(b, ascii('GIF8'));
  if (mime === 'image/webp') return starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8);
  if (mime === 'application/pdf') return starts(b, ascii('%PDF'));
  if (mime === 'video/mp4' || mime === 'video/quicktime') return starts(b, ascii('ftyp'), 4);
  if (mime === 'video/webm') return starts(b, [0x1a, 0x45, 0xdf, 0xa3]);
  if (mime === 'video/ogg') return starts(b, ascii('OggS'));
  if (mime === 'application/zip' || mime.startsWith('application/vnd.openxmlformats-officedocument.')) return starts(b, [0x50, 0x4b, 0x03, 0x04]);
  if (mime === 'application/msword' || mime === 'application/vnd.ms-excel' || mime === 'application/vnd.ms-powerpoint') return starts(b, [0xd0, 0xcf, 0x11, 0xe0]);
  if (mime === 'text/plain') return !b.includes(0);
  return false;
}
