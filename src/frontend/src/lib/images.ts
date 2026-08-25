import { stripMetadataLossless } from './image-metadata'

/** Types we can rewrite byte-for-byte. Anything else goes through the canvas re-encode. */
const LOSSLESS_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png'])

function renameForMimeType(filename: string, mimeType: string): string {
  const stem = filename.replace(/\.[^.]+$/, '')

  if (mimeType === 'image/png') return `${stem}.png`
  if (mimeType === 'image/webp') return `${stem}.webp`
  return `${stem}.jpg`
}

export function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Could not load image: ${url}`))
    image.src = url
  })
}

export function loadImageElementFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not load image blob'))
    }
    image.src = url
  })
}

/**
 * Fallback for formats we cannot rewrite losslessly: decode and re-encode, which drops every
 * metadata block as a side effect. `imageOrientation: 'from-image'` bakes any EXIF rotation into
 * the pixels so the re-encoded photo is not left sideways.
 *
 * Throws rather than quietly returning the original file — the caller decides what an
 * un-strippable image means, instead of the behaviour silently varying by browser.
 */
async function reencodeWithoutMetadata(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('Could not get a 2D canvas context to strip image metadata')
  }

  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()

  const preferredType = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg'
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, preferredType, preferredType === 'image/jpeg' ? 0.92 : undefined)
  })

  if (!blob) throw new Error('Could not re-encode image to strip metadata')

  return new File([blob], renameForMimeType(file.name, blob.type), {
    type: blob.type,
    lastModified: Date.now(),
  })
}

/**
 * Remove EXIF (including GPS), XMP, IPTC and comment metadata before an image is persisted.
 *
 * JPEG and PNG are rewritten at the container level, so the compressed pixels are bit-identical to
 * the original and the ICC colour profile survives. Other formats — and JPEGs with a rotation that
 * only the EXIF orientation tag describes — fall back to a canvas re-encode.
 */
export async function stripImageMetadata(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file

  if (LOSSLESS_TYPES.has(file.type)) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const stripped = stripMetadataLossless(bytes)
    if (stripped) {
      // The container type is unchanged, so the original filename still fits.
      return new File([stripped], file.name, { type: stripped.type, lastModified: Date.now() })
    }
  }

  return reencodeWithoutMetadata(file)
}
