// Byte-level metadata stripping for JPEG and PNG.
//
// The alternative — decoding to a canvas and re-encoding — throws metadata away as a side effect of
// re-compressing the pixels. That is lossy, slow on large files, discards the ICC colour profile, and
// hits browser canvas limits (Safari caps out around 16.7 MP). These parsers instead rewrite the
// container: the compressed image data and the tables needed to decode it are copied through
// untouched, while the parts that can carry a payload — JPEG APPn/COM segments, PNG ancillary
// chunks — are judged against a keep-list, so anything we have never heard of is dropped rather
// than passed on unexamined.
//
// Both parsers also stop at the end of the primary image — JPEG EOI, PNG IEND — and discard whatever
// follows it. Cameras and phones append entire second files there: a CIPA MPF image (with its own
// EXIF and GPS) or an Android Motion Photo MP4 of the scene. Those are not part of the picture the
// user opened and must not survive stripping.
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
const MARKER_APP14 = 0xee
const MARKER_APP15 = 0xef
const MARKER_COM = 0xfe

const EXIF_ORIENTATION_TAG = 0x0112

/**
 * PNG chunks we keep: the critical ones, everything that affects how the pixels are decoded or
 * coloured, and the APNG animation chunks. Anything else is dropped — `eXIf`, `tEXt`/`zTXt`/`iTXt`
 * and `tIME` obviously, but also private chunks like Fireworks' `prVW` (an embedded preview image)
 * or ImageMagick's `mkBF`. A keep-list is the right polarity here: a chunk type nobody has invented
 * yet defaults to "drop" rather than riding along unexamined.
 */
const PNG_KEPT_CHUNKS = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'cICP',
  'mDCV',
  'cLLI',
  'iCCP',
  'sBIT',
  'bKGD',
  'pHYs',
  'hIST',
  'sPLT',
  'acTL',
  'fcTL',
  'fdAT',
])

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
  // APPn segments are a keep-list: the only three that survive carry no personal data but do change
  // how the image decodes. Each is gated on its identifier string, because the marker number alone
  // says nothing about the payload — a JFXX APP0, for instance, is an embedded thumbnail image.
  if (marker >= MARKER_APP0 && marker <= MARKER_APP15) {
    // JFIF: pixel density and housekeeping; some decoders expect it.
    if (marker === MARKER_APP0 && matchesAscii(bytes, payloadStart, 'JFIF\0')) return false
    // ICC colour profile, split across multi-part chunks; keeping it means colours survive.
    if (marker === MARKER_APP2 && matchesAscii(bytes, payloadStart, 'ICC_PROFILE\0')) return false
    // Adobe: a version, two flag words and a colour-transform byte. libjpeg consults that byte to
    // resolve the colour space (always for CMYK/YCCK, and for RGB/YCbCr when there is no JFIF APP0),
    // so dropping it can silently change the decoded colours.
    if (marker === MARKER_APP14 && matchesAscii(bytes, payloadStart, 'Adobe')) return false
    // Everything else is EXIF, XMP, Photoshop/IPTC, MPF, FlashPix, Ducky, and friends.
    return true
  }
  // Free-text comments.
  return marker === MARKER_COM
}

/**
 * Find where an entropy-coded scan ends, given the offset of its first byte.
 *
 * Inside a scan a `0xFF` byte is either stuffed (`FF 00`, an escaped data byte), a fill byte
 * (`FF FF`), or a restart marker (`FF D0`–`FF D7`) that punctuates the scan itself. Anything else is
 * the next real marker, and the scan ends immediately before it. Returns the offset of that marker's
 * leading `0xFF`.
 */
function findScanEnd(bytes: Uint8Array, start: number): number {
  let offset = start
  while (offset < bytes.length) {
    const flag = bytes.indexOf(0xff, offset)
    if (flag < 0) break

    const next = bytes[flag + 1]
    if (next === undefined) throw new Error('Malformed JPEG: truncated scan data')
    if (next === 0x00) {
      offset = flag + 2
      continue
    }
    // A run of fill bytes may pad the gap before a marker; step over one and re-read.
    if (next === 0xff) {
      offset = flag + 1
      continue
    }
    if (next >= MARKER_RST_FIRST && next <= MARKER_RST_LAST) {
      offset = flag + 2
      continue
    }
    return flag
  }
  throw new Error('Malformed JPEG: scan data runs past end of file')
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
 * Walks SOI, then `FF <marker>` segments with a big-endian 2-byte length. At each SOS the header is
 * kept and the entropy-coded scan that follows is copied through verbatim, but the walk resumes at
 * the marker after it — a progressive JPEG has several scans, and APPn/COM segments can sit between
 * them. Parsing ends at the primary image's EOI; any trailer after that (an appended MPF image, a
 * Motion Photo MP4) is discarded. Throws on a truncated or malformed stream.
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

    // EOI closes the primary image. Everything past it belongs to some other payload, so stop here
    // and let it fall off the end of the rewritten file.
    if (marker === MARKER_EOI) {
      parts.push(bytes.subarray(offset, afterMarker))
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

    // The SOS header is followed by compressed data we must not touch; keep both, then pick the walk
    // back up at whatever marker ends the scan.
    if (marker === MARKER_SOS) {
      const scanEnd = findScanEnd(bytes, segmentEnd)
      parts.push(bytes.subarray(offset, scanEnd))
      offset = scanEnd
      continue
    }

    if (!isDroppableJpegSegment(marker, bytes, payloadStart)) {
      parts.push(bytes.subarray(offset, segmentEnd))
    }
    offset = segmentEnd
  }

  throw new Error('Malformed JPEG: no EOI marker found')
}

/**
 * Rewrite a PNG chunk stream, keeping only the chunks on `PNG_KEPT_CHUNKS` and stopping at IEND so
 * trailing data is discarded. Throws on a truncated or malformed file.
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

    if (PNG_KEPT_CHUNKS.has(type)) {
      parts.push(bytes.subarray(offset, chunkEnd))
    } else if ((type.charCodeAt(0) & 0x20) === 0) {
      // Critical bit clear (uppercase first letter): a decoder must not ignore this chunk, so we
      // cannot safely drop it either. Decline and let the caller fall back to re-encoding.
      throw new Error(`Unsupported critical PNG chunk: ${type}`)
    }
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
