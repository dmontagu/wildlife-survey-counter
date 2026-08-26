export const LS_IMAGE_KEY = 'wsc:image'
export const LS_IMAGE_BASE_KEY = 'wsc:image-base'
export const LS_IMAGE_DISPLAY_NAME_KEY = 'wsc:image-display-name'
export const LS_ACTIVE_CATEGORY_KEY = 'wsc:active-category'
export const LS_BBOX_CREATION_KEY = 'wsc:bbox-creation-enabled'
export const LS_MARKER_VISIBILITY_KEY = 'wsc:marker-visibility'
export const LS_ZOOM_SPEED_KEY = 'wsc:zoom-speed'
export const LS_RECENT_IMAGES_KEY = 'wsc:recent-images'
export const LS_RECENT_IMAGES_SORT_KEY = 'wsc:recent-images-sort'
const LS_ANNOTATION_PREFIX = 'wsc:annotations:'

export function imageStorageId(filename: string, basePath: string): string {
  return `${basePath}|${filename}`
}

export function annotationsStorageKey(filename: string, basePath: string): string {
  return `${LS_ANNOTATION_PREFIX}${encodeURIComponent(imageStorageId(filename, basePath))}`
}

export function legacyAnnotationsStorageKey(filename: string): string {
  return `${LS_ANNOTATION_PREFIX}${filename}`
}

/**
 * Where an unreadable annotations payload is set aside. A release that cannot parse what an earlier
 * one saved must never be the reason that work disappears: the original text is copied here before
 * anything can overwrite it, so it stays recoverable by hand or by a later build.
 */
export function unreadableAnnotationsKey(filename: string, basePath: string): string {
  return `${annotationsStorageKey(filename, basePath)}:unreadable`
}

/**
 * localStorage throws when the browser is out of quota, and can throw on any access at all when a
 * privacy mode blocks storage. A throw from one of these calls unwinds through a React effect and
 * takes the whole app down — including the reviewer's chance to export the work still in memory —
 * so every access the app makes goes through these wrappers and reports failure instead.
 */
export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nothing to do: the value is either already gone or unreachable.
  }
}
