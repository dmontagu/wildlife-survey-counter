import { categoryOption, DEFAULT_CATEGORY } from './config'
import type { Annotation, AnnotationCategory, AnnotationReviewStatus } from './types'

export const REVIEW_STATUS_COLORS: Record<AnnotationReviewStatus, string> = {
  confirmed: '#17B8FF',
  unconfirmed: '#F59E0B',
}

/** Per-class colours live on ELK_CATEGORY_OPTIONS in config.ts; these are the non-class marker states. */
export const MARKER_STATE_COLORS = {
  ignored: '#FF453A',
}

export const MINIMAP_DEFAULT_COLOR = '#26C4FF'

export const MARKER_HALO_COLOR = 'rgba(6, 20, 28, 0.92)'

/** Returns '#000' or '#fff' for best contrast on the given hex color */
export function textColorFor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  // Perceived luminance (ITU-R BT.709)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 150 ? '#000' : '#fff'
}

export const SELECTION_COLOR = '#FACC15'
export const SELECTION_FILL = 'rgba(250, 204, 21, 0.18)'

export function markerColorFor(annotation: Annotation): string {
  if (annotation.state === 'rejected') return MARKER_STATE_COLORS.ignored
  if (annotation.reviewStatus === 'unconfirmed') return REVIEW_STATUS_COLORS.unconfirmed
  return categoryColorFor(annotation.category)
}

export function minimapMarkerColorFor(annotation: Annotation): string {
  if (annotation.state === 'rejected') return MARKER_STATE_COLORS.ignored
  if (annotation.reviewStatus === 'unconfirmed') return REVIEW_STATUS_COLORS.unconfirmed
  if (annotation.category === DEFAULT_CATEGORY) return MINIMAP_DEFAULT_COLOR
  return categoryColorFor(annotation.category)
}

export function categoryColorFor(category: AnnotationCategory): string {
  return categoryOption(category).color
}
