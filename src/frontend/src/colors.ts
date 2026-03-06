import type { Annotation, AnnotationCategory, AnnotationState } from './types'

export const STATE_COLORS: Record<AnnotationState, string> = {
  'auto-detected': '#f59e0b',
  confirmed: '#22c55e',
  rejected: '#ef4444',
  'manually-added': '#00e5ff',
}

export const CATEGORY_COLORS: Record<'default' | 'bull' | 'spike' | 'ignored', string> = {
  default: '#17B8FF',
  bull: '#FF5D95',
  spike: '#73E46F',
  ignored: '#FF453A',
}

/** Brighter variants for minimap dots (tiny, need more contrast on dark background) */
export const MINIMAP_COLORS: Record<AnnotationState, string> = {
  'auto-detected': '#26C4FF',
  confirmed: '#26C4FF',
  rejected: '#FF5A52',
  'manually-added': '#26C4FF',
}

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
  if (annotation.state === 'rejected') return CATEGORY_COLORS.ignored
  if (annotation.category === 'bull') return CATEGORY_COLORS.bull
  if (annotation.category === 'spike') return CATEGORY_COLORS.spike
  return CATEGORY_COLORS.default
}

export function minimapMarkerColorFor(annotation: Annotation): string {
  if (annotation.state === 'rejected') return MINIMAP_COLORS.rejected
  if (annotation.category === 'bull') return CATEGORY_COLORS.bull
  if (annotation.category === 'spike') return CATEGORY_COLORS.spike
  return MINIMAP_COLORS.confirmed
}

export function categoryColorFor(category: AnnotationCategory): string {
  if (category === 'bull') return CATEGORY_COLORS.bull
  if (category === 'spike') return CATEGORY_COLORS.spike
  return CATEGORY_COLORS.default
}
