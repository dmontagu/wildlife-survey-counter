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

export async function stripImageMetadata(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file

  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return file
  }

  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()

  const preferredType = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg'
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, preferredType, preferredType === 'image/jpeg' ? 0.92 : undefined)
  })

  if (!blob) return file

  return new File([blob], renameForMimeType(file.name, blob.type), {
    type: blob.type,
    lastModified: Date.now(),
  })
}
