import { categoryOption, DEFAULT_CATEGORY, ELK_CATEGORY_OPTIONS, isAnnotationCategory } from '../config'
import type {
  Annotation,
  AnnotationCategory,
  AnnotationReviewStatus,
  AnnotationState,
  AnnotationSummary,
  CategorySummaryKey,
} from '../types'

const VALID_STATES = new Set<AnnotationState>(['auto-detected', 'confirmed', 'rejected', 'manually-added'])
const VALID_REVIEW_STATUSES = new Set<AnnotationReviewStatus>(['confirmed', 'unconfirmed'])

function normalizeBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const x1 = Number(value[0])
  const y1 = Number(value[1])
  const x2 = Number(value[2])
  const y2 = Number(value[3])
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null
  return [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)]
}

/**
 * Resolve the class of a raw (possibly legacy) annotation. Older saves used `category: null` to mean cow,
 * so null/missing/unknown values fall back to the default class rather than being rejected.
 */
function inferCategory(raw: Record<string, unknown>): AnnotationCategory {
  if (isAnnotationCategory(raw.category)) return raw.category
  const label = typeof raw.label === 'string' ? raw.label.toLowerCase().replace(/[-_]+/g, ' ') : ''
  if (label.includes('unclassified antlerless')) return 'unclassified-antlerless'
  if (label.includes('unclassified')) return 'unclassified'
  if (label.includes('bull')) return 'bull'
  if (label.includes('spike')) return 'spike'
  return DEFAULT_CATEGORY
}

export function normalizeAnnotation(raw: unknown, index = 0): Annotation {
  const data = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const id = Number(data.id)
  const x = Number(data.x)
  const y = Number(data.y)
  const state: AnnotationState =
    typeof data.state === 'string' && VALID_STATES.has(data.state as AnnotationState)
      ? (data.state as AnnotationState)
      : 'confirmed'
  const reviewStatus: AnnotationReviewStatus =
    typeof data.reviewStatus === 'string' && VALID_REVIEW_STATUSES.has(data.reviewStatus as AnnotationReviewStatus)
      ? (data.reviewStatus as AnnotationReviewStatus)
      : 'confirmed'

  return {
    id: Number.isFinite(id) ? id : index + 1,
    x: Number.isFinite(x) ? Math.round(x) : 0,
    y: Number.isFinite(y) ? Math.round(y) : 0,
    bbox: normalizeBbox(data.bbox),
    detection_confidence: typeof data.detection_confidence === 'number' ? data.detection_confidence : null,
    classification_confidence:
      typeof data.classification_confidence === 'number' ? data.classification_confidence : null,
    source: typeof data.source === 'string' ? data.source : 'manual',
    label: typeof data.label === 'string' && data.label.length > 0 ? data.label : 'elk',
    category: inferCategory(data),
    state,
    reviewStatus,
  }
}

export function normalizeAnnotations(raw: unknown): Annotation[] {
  if (!Array.isArray(raw)) return []
  return raw.map((annotation, index) => normalizeAnnotation(annotation, index))
}

export function prepareImportedAnnotations(raw: unknown): Annotation[] {
  return normalizeAnnotations(raw).map((annotation) =>
    isIgnoredAnnotation(annotation) ? annotation : { ...annotation, reviewStatus: 'unconfirmed' },
  )
}

export function isIgnoredAnnotation(annotation: Annotation): boolean {
  return annotation.state === 'rejected'
}

export function isCountedAnnotation(annotation: Annotation): boolean {
  return !isIgnoredAnnotation(annotation)
}

export function emptyCategoryCounts(): Record<CategorySummaryKey, number> {
  const counts = {} as Record<CategorySummaryKey, number>
  for (const option of ELK_CATEGORY_OPTIONS) counts[option.summaryKey] = 0
  return counts
}

export function summarizeAnnotations(annotations: Annotation[]): AnnotationSummary {
  return annotations.reduce<AnnotationSummary>(
    (summary, annotation) => {
      if (isIgnoredAnnotation(annotation)) {
        summary.ignored += 1
        return summary
      }

      summary.counted += 1
      summary[categoryOption(annotation.category).summaryKey] += 1
      if (annotation.reviewStatus === 'unconfirmed') summary.unconfirmed += 1
      return summary
    },
    { ...emptyCategoryCounts(), counted: 0, ignored: 0, unconfirmed: 0 },
  )
}

/**
 * One-line count summary for the Recent Work lists, e.g. "12 counted, 3 bulls, 1 unclassified".
 * The total always shows; individual classes (other than the default cow class) show only when non-zero.
 */
export function formatCountSummary(counts: { counted: number } & Record<CategorySummaryKey, number>): string {
  const parts = [`${counts.counted} counted`]
  for (const option of ELK_CATEGORY_OPTIONS) {
    if (option.id === DEFAULT_CATEGORY) continue
    const value = counts[option.summaryKey]
    if (value > 0) parts.push(`${value} ${option.countLabel}`)
  }
  return parts.join(', ')
}

export function getVisibleAnnotations(
  annotations: Annotation[],
  options: { showRejected: boolean; confidenceThreshold: number },
): Annotation[] {
  return annotations.filter((annotation) => {
    if (isIgnoredAnnotation(annotation) && !options.showRejected) return false
    if (annotation.detection_confidence !== null && annotation.detection_confidence < options.confidenceThreshold) {
      return false
    }
    return true
  })
}

export function getDisplayNumbers(annotations: Annotation[]): Map<number, number> {
  const sorted = [...annotations].sort((a, b) => a.y - b.y || a.x - b.x)
  const map = new Map<number, number>()
  for (let index = 0; index < sorted.length; index++) {
    map.set(sorted[index]!.id, index + 1)
  }
  return map
}

export function categoryBadgeLabel(category: AnnotationCategory): string | null {
  return categoryOption(category).badge
}
