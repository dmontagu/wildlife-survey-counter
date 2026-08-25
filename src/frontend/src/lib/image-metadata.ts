// Byte-level metadata stripping for JPEG and PNG.
//
// The alternative — decoding to a canvas and re-encoding — throws metadata away as a side effect of
// re-compressing the pixels. That is lossy, slow on large files, discards the ICC colour profile, and
// hits browser canvas limits (Safari caps out around 16.7 MP). These parsers instead rewrite the
// container: the compressed image data is copied through untouched, and only the segments/chunks that
// can carry personal data (GPS, camera serials, timestamps, captions) are omitted.
//
// Every parser throws on anything it does not fully understand, so callers can fall back to the
// canvas path rather than emitting a file that a decoder might reject.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// JPEG markers we treat specially. Everything not listed here is copied through verbatim.
const MARKER_TEM = 0x01
const MARKER_RST_FIRST = 0xd0
const MARKER_RST_LAST = 0xd7
const MARKER_SOI = 0xd8
const MARKER_EOI = 0xd9
const MARKER_SOS = 0xda
const MARKER_APP0 = 0xe0
const MARKER_APP1 = 0xe1
const MARKER_APP2 = 0xe2
const MARKER_APP15 = 0xef
const MARKER_COM = 0xfe

const EXIF_ORIENTATION_TAG = 0x0112

/** PNG chunks that can carry EXIF, captions, or timestamps. Everything else — including `iCCP`,
 * `sRGB`, `gAMA` and `cHRM` — is preserved so colour rendering is unchanged. */
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i]!)
  return text
}

export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

export function looksLikePng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

/**
 * Read the EXIF orientation (tag 0x0112) out of an APP1 payload, or `null` when the segment is not
 * EXIF or does not carry the tag. `start` points at the first payload byte (after the length field).
 */
function readExifOrientation(bytes: Uint8Array, start: number, end: number): number | null {
  // "Exif\0\0" followed by a TIFF header.
  if (end - start < 14) return null
  if (!matchesAscii(bytes, start, 'Exif')) return null
  if (bytes[start + 4] !== 0x00 || bytes[start + 5] !== 0x00) return null

  const view = viewOf(bytes)
  const tiff = start + 6
  const byteOrder = view.getUint16(tiff)
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null
  const littleEndian = byteOrder === 0x4949
  if (view.getUint16(tiff + 2, littleEndian) !== 0x002a) return null

  const ifd = tiff + view.getUint32(tiff + 4, littleEndian)
  if (ifd < tiff || ifd + 2 > end) return null

  const entryCount = view.getUint16(ifd, littleEndian)
  for (let index = 0; index < entryCount; index++) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > end) return null
    if (view.getUint16(entry, littleEndian) === EXIF_ORIENTATION_TAG) {
      // A SHORT with count 1 lives in the first two bytes of the 4-byte value field.
      return view.getUint16(entry + 8, littleEndian)
    }
  }
  return null
}

function isDroppableJpegSegment(marker: number, bytes: Uint8Array, payloadStart: number): boolean {
  // APP0 is JFIF (density/thumbnail housekeeping, no personal data) and some decoders expect it.
  if (marker === MARKER_APP0) return false
  // APP2 carries the ICC colour profile in multi-part chunks; keeping it means colours survive.
  if (marker === MARKER_APP2 && matchesAscii(bytes, payloadStart, 'ICC_PROFILE\0')) return false
  // Everything else in APP1..APP15 is EXIF, XMP, Photoshop/IPTC, MPF, Ducky, and friends.
  if (marker >= MARKER_APP1 && marker <= MARKER_APP15) return true
  // Free-text comments.
  return marker === MARKER_COM
}

export interface JpegStripResult {
  /** Slices of the input, in order, that make up the stripped file. */
  parts: Uint8Array[]
  /** EXIF orientation found before stripping; 1 when absent (i.e. no rotation was implied). */
  orientation: number
}

/**
 * Rewrite a JPEG marker stream without its metadata segments.
 *
 * Walks SOI, then `FF <marker>` segments with a big-endian 2-byte length, until SOS — from which
 * point the entropy-coded scan (and anything after it) is copied verbatim. Throws on a truncated or
 * malformed stream.
 */
export function stripJpegMetadata(bytes: Uint8Array): JpegStripResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== MARKER_SOI) {
    throw new Error('Not a JPEG: missing SOI marker')
  }

  const view = viewOf(bytes)
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]
  let orientation = 1
  let offset = 2

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(`Malformed JPEG: expected a marker at byte ${offset}`)

    // Any number of 0xFF fill bytes may precede the marker identifier.
    let markerAt = offset
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt++
    if (markerAt >= bytes.length) throw new Error('Malformed JPEG: truncated marker')

    const marker = bytes[markerAt]!
    const afterMarker = markerAt + 1

    // Standalone markers carry no payload.
    if (marker === MARKER_SOI || marker === MARKER_TEM || (marker >= MARKER_RST_FIRST && marker <= MARKER_RST_LAST)) {
      parts.push(bytes.subarray(offset, afterMarker))
      offset = afterMarker
      continue
    }

    // From the scan (or a bare EOI) onwards the stream is compressed data we must not touch.
    if (marker === MARKER_SOS || marker === MARKER_EOI) {
      parts.push(bytes.subarray(offset))
      return { parts, orientation }
    }

    if (afterMarker + 2 > bytes.length) throw new Error('Malformed JPEG: truncated segment length')
    const length = view.getUint16(afterMarker)
    if (length < 2) throw new Error('Malformed JPEG: invalid segment length')
    const segmentEnd = afterMarker + length
    if (segmentEnd > bytes.length) throw new Error('Malformed JPEG: segment runs past end of file')

    const payloadStart = afterMarker + 2
    if (marker === MARKER_APP1) {
      orientation = readExifOrientation(bytes, payloadStart, segmentEnd) ?? orientation
    }

    if (!isDroppableJpegSegment(marker, bytes, payloadStart)) {
      parts.push(bytes.subarray(offset, segmentEnd))
    }
    offset = segmentEnd
  }

  throw new Error('Malformed JPEG: no scan data found')
}

/**
 * Rewrite a PNG chunk stream without its metadata chunks. Throws on a truncated or malformed file.
 */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array[] {
  if (!looksLikePng(bytes)) throw new Error('Not a PNG: bad signature')

  const view = viewOf(bytes)
  const parts: Uint8Array[] = [bytes.subarray(0, 8)]
  let offset = 8
  let seenHeader = false

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('Malformed PNG: truncated chunk')
    const length = view.getUint32(offset)
    if (length > 0x7fffffff) throw new Error('Malformed PNG: implausible chunk length')
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) throw new Error('Malformed PNG: chunk runs past end of file')

    const type = readAscii(bytes, offset + 4, 4)
    if (!seenHeader) {
      if (type !== 'IHDR') throw new Error('Malformed PNG: first chunk is not IHDR')
      seenHeader = true
    }

    if (!PNG_METADATA_CHUNKS.has(type)) parts.push(bytes.subarray(offset, chunkEnd))
    offset = chunkEnd

    // Anything trailing IEND is not part of the image.
    if (type === 'IEND') return parts
  }

  throw new Error('Malformed PNG: no IEND chunk')
}

/**
 * Strip metadata without touching the compressed pixels, or return `null` when that is not possible
 * and the caller should fall back to re-encoding.
 *
 * Returns `null` for formats we do not parse, for files we cannot parse cleanly, and for JPEGs whose
 * EXIF orientation is not 1. That last case matters: a phone photo shot sideways stores upright
 * pixels plus an orientation tag, so dropping the tag losslessly would leave the image displayed
 * rotated. Re-encoding via `createImageBitmap(..., { imageOrientation: 'from-image' })` bakes the
 * rotation into the pixels instead, which costs quality but keeps the photo the right way up.
 */
export function stripMetadataLossless(bytes: Uint8Array): Blob | null {
  try {
    if (looksLikeJpeg(bytes)) {
      const { parts, orientation } = stripJpegMetadata(bytes)
      if (orientation !== 1) return null
      return new Blob(parts, { type: 'image/jpeg' })
    }
    if (looksLikePng(bytes)) {
      return new Blob(stripPngMetadata(bytes), { type: 'image/png' })
    }
  } catch {
    return null
  }
  return null
}
