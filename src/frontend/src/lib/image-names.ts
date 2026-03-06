interface NamedImageLike {
  filename: string
  displayName?: string | null
}

export function normalizeDisplayName(displayName: string | null | undefined, filename: string): string | null {
  const trimmed = displayName?.trim()
  if (!trimmed || trimmed === filename) return null
  return trimmed
}

export function displayNameFor(image: NamedImageLike): string {
  return normalizeDisplayName(image.displayName, image.filename) ?? image.filename
}

export function hasCustomDisplayName(image: NamedImageLike): boolean {
  return normalizeDisplayName(image.displayName, image.filename) !== null
}

export function stemForFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

export function extensionForFilename(filename: string): string {
  const match = filename.match(/\.([^.]+)$/)
  return match ? match[1]!.toLowerCase() : 'jpg'
}
