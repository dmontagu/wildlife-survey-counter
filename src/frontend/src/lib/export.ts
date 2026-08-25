import { categoryColorFor, MARKER_HALO_COLOR, markerColorFor, textColorFor } from '../colors'
import { categoryOption, ELK_CATEGORY_OPTIONS } from '../config'
import type { Annotation, ImageInfo } from '../types'
import { categoryBadgeLabel, getDisplayNumbers, summarizeAnnotations } from './annotations'
import { displayNameFor, extensionForFilename, stemForFilename } from './image-names'
import { loadImageElement, loadImageElementFromBlob } from './images'

interface BulkJsonImageExport {
  filename: string
  displayName: string | null
  width: number
  height: number
  annotations: Annotation[]
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + width - radius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius)
  ctx.lineTo(x + width, y + height - radius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  ctx.lineTo(x + radius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath()
  ctx.moveTo(x, y - radius)
  ctx.lineTo(x + radius, y)
  ctx.lineTo(x, y + radius)
  ctx.lineTo(x - radius, y)
  ctx.closePath()
}

function exportMimeTypeFor(filename: string): string {
  const extension = extensionForFilename(filename)
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  return 'image/jpeg'
}

function exportExtensionFor(filename: string): string {
  const extension = extensionForFilename(filename)
  if (extension === 'png' || extension === 'webp') return extension
  return 'jpg'
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function renderSourceCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create export canvas')
  ctx.drawImage(image, 0, 0)
  return canvas
}

function drawCategoryIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  category: Annotation['category'],
  radius: number,
  stroke: string,
  scale: number,
) {
  const { indicator } = categoryOption(category)
  if (indicator === 'none') return

  ctx.save()
  ctx.strokeStyle = stroke
  ctx.lineWidth = Math.max(2, 2.5 * scale)

  if (indicator === 'diamond') {
    drawDiamond(ctx, x, y, radius + Math.max(4.5, 4.75 * scale))
  } else {
    if (indicator === 'dashed-ring') ctx.setLineDash([3.5 * scale, 3 * scale])
    ctx.beginPath()
    ctx.arc(x, y, radius + Math.max(2.5, 2.5 * scale), 0, Math.PI * 2)
  }
  ctx.stroke()
  ctx.restore()
}

function drawCategoryBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  category: Annotation['category'],
  scale: number,
) {
  const label = categoryBadgeLabel(category)
  if (!label) return

  ctx.save()
  // Keep in sync with drawCategoryBadge in hooks/useCanvasRenderer.ts: the box grows to fit "UA".
  ctx.font = `bold ${7 * scale}px sans-serif`
  const badgeWidth = Math.max(12 * scale, ctx.measureText(label).width + 6 * scale)
  const badgeHeight = 10 * scale
  const bx = x + 7 * scale
  const by = y - 11 * scale
  const radius = 3 * scale
  const stroke = categoryColorFor(category)

  if (categoryOption(category).indicator === 'diamond') {
    drawDiamond(ctx, bx + badgeWidth / 2, by + badgeHeight / 2, 6 * scale)
  } else {
    drawRoundedRect(ctx, bx, by, badgeWidth, badgeHeight, radius)
  }

  ctx.fillStyle = 'rgba(20, 27, 24, 0.92)'
  ctx.fill()
  ctx.strokeStyle = stroke
  ctx.lineWidth = Math.max(1, 1.25 * scale)
  ctx.stroke()

  ctx.fillStyle = stroke
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, bx + badgeWidth / 2, by + badgeHeight / 2 + 0.25 * scale)
  ctx.restore()
}

function drawAnnotationBbox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  bbox: [number, number, number, number],
  stroke: string,
  scale: number,
) {
  const [x1, y1, x2, y2] = bbox

  ctx.save()
  ctx.strokeStyle = MARKER_HALO_COLOR
  ctx.lineWidth = Math.max(3, 4 * scale)
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

  ctx.strokeStyle = stroke
  ctx.lineWidth = Math.max(1.5, 2 * scale)
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

  ctx.beginPath()
  ctx.moveTo(x, y - radius - 1)
  ctx.lineTo(x, y1)
  ctx.stroke()
  ctx.restore()
}

async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality = 0.92): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, mimeType, quality)
  })
  if (!blob) throw new Error('Could not create export image')
  return blob
}

function renderAnnotatedCanvas(
  image: HTMLImageElement,
  annotations: Annotation[],
  imageLabel: string,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create export canvas')

  ctx.drawImage(image, 0, 0)

  const visibleAnnotations = annotations.filter((annotation) => annotation.state !== 'rejected')
  const displayNumbers = getDisplayNumbers(visibleAnnotations)
  const markerScale = Math.max(image.width, image.height) / 2200
  const radius = Math.max(5, 8 * markerScale)

  for (const annotation of visibleAnnotations) {
    const color = markerColorFor(annotation)
    drawCategoryIndicator(
      ctx,
      annotation.x,
      annotation.y,
      annotation.category,
      radius,
      categoryColorFor(annotation.category),
      markerScale,
    )

    ctx.save()
    ctx.shadowColor = MARKER_HALO_COLOR
    ctx.shadowBlur = Math.max(6, 10 * markerScale)
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.beginPath()
    ctx.arc(annotation.x, annotation.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(1, 1.5 * markerScale)
    ctx.stroke()

    const label = String(displayNumbers.get(annotation.id) ?? annotation.id)
    ctx.fillStyle = textColorFor(color)
    ctx.font = `bold ${Math.max(9, 10 * markerScale)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, annotation.x, annotation.y + 0.5 * markerScale)

    drawCategoryBadge(ctx, annotation.x, annotation.y, annotation.category, markerScale)

    if (annotation.bbox) {
      drawAnnotationBbox(ctx, annotation.x, annotation.y, radius, annotation.bbox, color, markerScale)
    }
  }

  drawSummaryPanel(ctx, image, annotations, imageLabel)

  return canvas
}

/**
 * Count panel in the top-left of the review image: title, total, then one cell per elk class laid out in
 * two columns, then the unconfirmed count. The panel grows to fit however many classes exist.
 */
function drawSummaryPanel(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  annotations: Annotation[],
  imageLabel: string,
) {
  const summary = summarizeAnnotations(annotations)
  const panelScale = Math.min(2.6, Math.max(1, Math.max(image.width, image.height) / 1600))
  const panelX = 16
  const panelY = 16
  const paddingX = 12 * panelScale
  const lineHeight = 17 * panelScale
  const columnGap = 14 * panelScale
  const bodyFont = `${12 * panelScale}px sans-serif`

  const classCells = ELK_CATEGORY_OPTIONS.map((option) => `${option.label}: ${summary[option.summaryKey]}`)
  const classRows = Math.ceil(classCells.length / 2)

  ctx.font = bodyFont
  const columnWidth = Math.max(100 * panelScale, ...classCells.map((cell) => ctx.measureText(cell).width)) + columnGap
  const panelWidth = Math.max(236 * panelScale, paddingX * 2 + columnWidth * 2 - columnGap)

  const titleY = panelY + 22 * panelScale
  const countedY = panelY + 44 * panelScale
  const classesY = countedY + lineHeight
  const unconfirmedY = classesY + classRows * lineHeight
  const panelHeight = unconfirmedY - panelY + 10 * panelScale

  ctx.fillStyle = 'rgba(22, 28, 24, 0.84)'
  drawRoundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 12 * panelScale)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.lineWidth = Math.max(1, panelScale)
  ctx.stroke()

  ctx.fillStyle = '#F5F5F0'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `bold ${14 * panelScale}px sans-serif`
  ctx.fillText(imageLabel, panelX + paddingX, titleY)
  ctx.font = bodyFont
  ctx.fillText(`Counted: ${summary.counted}`, panelX + paddingX, countedY)
  classCells.forEach((cell, index) => {
    const column = index % 2
    const row = Math.floor(index / 2)
    ctx.fillText(cell, panelX + paddingX + column * columnWidth, classesY + row * lineHeight)
  })
  ctx.fillText(`Unconfirmed: ${summary.unconfirmed}`, panelX + paddingX, unconfirmedY)
}

function buildExportNames(image: Pick<ImageInfo, 'filename' | 'displayName'>) {
  const imageLabel = displayNameFor(image)
  const labelStem = stemForFilename(imageLabel)
  const sourceExtension = exportExtensionFor(image.filename)

  return {
    imageLabel,
    annotatedFilename: `review_${labelStem}.jpg`,
    jsonFilename: `annotations_${labelStem}.json`,
    originalFilename: `original_${labelStem}.${sourceExtension}`,
  }
}

export function buildExportPayload(
  image: Pick<ImageInfo, 'filename' | 'displayName' | 'width' | 'height'>,
  annotations: Annotation[],
) {
  const { imageLabel } = buildExportNames(image)

  return {
    image: {
      filename: imageLabel,
      sourceFilename: image.filename,
      width: image.width,
      height: image.height,
    },
    summary: summarizeAnnotations(annotations),
    annotations,
  }
}

export async function exportAnnotatedImage(image: ImageInfo, annotations: Annotation[]) {
  const { imageLabel, annotatedFilename } = buildExportNames(image)
  const annotatedCanvas = renderAnnotatedCanvas(image.element, annotations, imageLabel)
  const reviewBlob = await canvasToBlob(annotatedCanvas, 'image/jpeg')
  downloadBlob(reviewBlob, annotatedFilename)
}

export async function exportOriginalImage(image: ImageInfo) {
  const { originalFilename } = buildExportNames(image)
  const sourceCanvas = renderSourceCanvas(image.element)
  const mimeType = exportMimeTypeFor(image.filename)
  const originalBlob = await canvasToBlob(sourceCanvas, mimeType)
  downloadBlob(originalBlob, originalFilename)
}

export async function exportResults(image: ImageInfo, annotations: Annotation[]) {
  exportJsonOnly(image, annotations)
  await exportAnnotatedImage(image, annotations)
}

export async function exportResultsFromUrl(
  url: string,
  filename: string,
  displayName: string | null,
  width: number,
  height: number,
  annotations: Annotation[],
) {
  const image = await loadImageElement(url)
  await exportResults(
    {
      filename,
      displayName,
      width: width || image.width,
      height: height || image.height,
      element: image,
      basePath: '',
    },
    annotations,
  )
}

export async function exportResultsFromBlob(
  blob: Blob,
  filename: string,
  displayName: string | null,
  width: number,
  height: number,
  annotations: Annotation[],
) {
  const image = await loadImageElementFromBlob(blob)
  await exportResults(
    {
      filename,
      displayName,
      width: width || image.width,
      height: height || image.height,
      element: image,
      basePath: '',
    },
    annotations,
  )
}

export function exportJsonOnly(
  image: Pick<ImageInfo, 'filename' | 'displayName' | 'width' | 'height'>,
  annotations: Annotation[],
) {
  const payload = buildExportPayload(image, annotations)
  const { jsonFilename } = buildExportNames(image)
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  downloadBlob(blob, jsonFilename)
}

export function exportCombinedJsonOnly(images: BulkJsonImageExport[]) {
  const payload = {
    exportedAt: new Date().toISOString(),
    imageCount: images.length,
    images: images.map((image) => ({
      image: {
        filename: image.filename,
        displayName: image.displayName,
        width: image.width,
        height: image.height,
      },
      summary: summarizeAnnotations(image.annotations),
      annotations: image.annotations,
    })),
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  downloadBlob(blob, 'annotations_all_saved_work.json')
}
