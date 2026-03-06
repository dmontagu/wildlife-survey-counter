import { categoryColorFor, MARKER_HALO_COLOR, markerColorFor, textColorFor } from '../colors'
import type { Annotation, ImageInfo } from '../types'
import { categoryBadgeLabel, getDisplayNumbers, summarizeAnnotations } from './annotations'
import { loadImageElement, loadImageElementFromBlob } from './images'

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

function drawCategoryIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  category: Annotation['category'],
  radius: number,
  stroke: string,
  scale: number,
) {
  if (!category) return

  ctx.strokeStyle = stroke
  ctx.lineWidth = Math.max(1.5, 2 * scale)

  if (category === 'bull') {
    ctx.beginPath()
    ctx.arc(x, y, radius + Math.max(1.5, 1.5 * scale), 0, Math.PI * 2)
    ctx.stroke()
    return
  }

  drawDiamond(ctx, x, y, radius + Math.max(3, 3.5 * scale))
  ctx.stroke()
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
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

  const badgeWidth = 12 * scale
  const badgeHeight = 10 * scale
  const bx = x + 7 * scale
  const by = y - 11 * scale
  const radius = 3 * scale
  const stroke = categoryColorFor(category)

  if (category === 'spike') {
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
  ctx.font = `bold ${7 * scale}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, bx + badgeWidth / 2, by + badgeHeight / 2 + 0.25 * scale)
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

function renderAnnotatedCanvas(
  image: HTMLImageElement,
  annotations: Annotation[],
  filename: string,
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
    const categoryColor = annotation.category ? categoryColorFor(annotation.category) : null

    if (categoryColor) {
      drawCategoryIndicator(ctx, annotation.x, annotation.y, annotation.category, radius, categoryColor, markerScale)
    }

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

  const summary = summarizeAnnotations(annotations)
  const panelWidth = Math.max(220, image.width * 0.18)
  const panelHeight = 86
  const panelX = image.width - panelWidth - 16
  const panelY = 16

  ctx.fillStyle = 'rgba(22, 28, 24, 0.82)'
  ctx.fillRect(panelX, panelY, panelWidth, panelHeight)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.lineWidth = 1
  ctx.strokeRect(panelX, panelY, panelWidth, panelHeight)

  ctx.fillStyle = '#F5F5F0'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = 'bold 14px sans-serif'
  ctx.fillText(filename, panelX + 12, panelY + 22)
  ctx.font = '12px sans-serif'
  ctx.fillText(`Counted: ${summary.counted}`, panelX + 12, panelY + 42)
  ctx.fillText(`Bulls: ${summary.bulls}`, panelX + 12, panelY + 58)
  ctx.fillText(`Spikes: ${summary.spikes}`, panelX + 110, panelY + 58)
  ctx.fillText(`Ignored: ${summary.ignored}`, panelX + 12, panelY + 74)

  return canvas
}

export function buildExportPayload(
  image: Pick<ImageInfo, 'filename' | 'width' | 'height'>,
  annotations: Annotation[],
) {
  return {
    image,
    summary: summarizeAnnotations(annotations),
    annotations,
  }
}

export async function exportResults(image: ImageInfo, annotations: Annotation[]) {
  const payload = buildExportPayload(image, annotations)
  const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  downloadBlob(jsonBlob, `annotations_${image.filename}.json`)

  const annotatedCanvas = renderAnnotatedCanvas(image.element, annotations, image.filename)
  const reviewBlob = await new Promise<Blob | null>((resolve) => {
    annotatedCanvas.toBlob(resolve, 'image/jpeg', 0.92)
  })
  if (!reviewBlob) throw new Error('Could not export review image')
  downloadBlob(reviewBlob, `review_${image.filename.replace(/\.[^.]+$/, '')}.jpg`)
}

export async function exportResultsFromUrl(
  url: string,
  filename: string,
  width: number,
  height: number,
  annotations: Annotation[],
) {
  const image = await loadImageElement(url)
  await exportResults(
    {
      filename,
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
  width: number,
  height: number,
  annotations: Annotation[],
) {
  const image = await loadImageElementFromBlob(blob)
  await exportResults(
    {
      filename,
      width: width || image.width,
      height: height || image.height,
      element: image,
      basePath: '',
    },
    annotations,
  )
}

export function exportJsonOnly(image: ImageInfo, annotations: Annotation[]) {
  const payload = buildExportPayload(image, annotations)
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  downloadBlob(blob, `annotations_${image.filename}.json`)
}
