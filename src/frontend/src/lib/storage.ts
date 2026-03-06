export const LS_IMAGE_KEY = 'wsc:image'
export const LS_IMAGE_BASE_KEY = 'wsc:image-base'
export const LS_INTERACTION_MODE_KEY = 'wsc:interaction-mode'
export const LS_ACTIVE_CATEGORY_KEY = 'wsc:active-category'
export const LS_BBOX_CREATION_KEY = 'wsc:bbox-creation-enabled'
export const LS_ZOOM_SPEED_KEY = 'wsc:zoom-speed'
export const LS_RECENT_IMAGES_KEY = 'wsc:recent-images'
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
