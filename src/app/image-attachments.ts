// Images attached to a chat message (dragged, picked with + or pasted). Each one is made smaller before
// it is sent (about 1.5 megapixels at most), and the chat keeps only a small thumbnail of it; the image
// goes to the model with the current request only, never with the history of later ones.

export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }
/** What may be attached, before it is made smaller. */
export const MAX_IMAGE_INPUT_BYTES = 20_000_000
export const MAX_IMAGES = 4
/** About 1.5 MP: enough for a screenshot to be read, and it keeps the image tokens and memory in check. */
export const MAX_IMAGE_PIXELS = 1_500_000
export const THUMBNAIL_EDGE = 480

export type ChatImage = { id: string; name: string; mime: string; data: string; width: number; height: number; thumbnail: string }

export const isImageFile = (file: { type: string; name: string }) => file.type in IMAGE_TYPES || /\.(?:png|jpe?g|webp)$/i.test(file.name)

/** Why an image cannot be attached, or null. `attached` is how many the message already has. */
export function imageProblem(file: { name: string; type: string; size: number }, attached: number): string | null {
  if (!(file.type in IMAGE_TYPES)) return `${file.name} (només PNG, JPEG o WebP)`
  if (file.size <= 0) return `${file.name} (és buit)`
  if (file.size > MAX_IMAGE_INPUT_BYTES) return `${file.name} (supera els 20 MB)`
  if (attached >= MAX_IMAGES) return `${file.name} (com a molt ${MAX_IMAGES} imatges per missatge)`
  return null
}

/** The size an image is sent at: its own if small enough, otherwise scaled down (same shape) to at most `maxPixels`. */
export function fitWithin(width: number, height: number, maxPixels = MAX_IMAGE_PIXELS): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0 }
  if (width * height <= maxPixels) return { width: Math.round(width), height: Math.round(height) }
  const scale = Math.sqrt(maxPixels / (width * height))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

/** The thumbnail's size: its longest side at most `edge`. */
export function thumbnailSize(width: number, height: number, edge = THUMBNAIL_EDGE): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0 }
  const scale = Math.min(1, edge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The format it is sent in: PNG stays PNG (screenshots, transparency); the others go as JPEG. */
export const outputType = (mime: string) => (mime === "image/png" ? "image/png" : "image/jpeg")

async function draw(bitmap: ImageBitmap, size: { width: number; height: number }, type: string, quality: number) {
  const canvas = document.createElement("canvas")
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext("2d")
  if (!context) throw new Error("no s’ha pogut dibuixar")
  context.drawImage(bitmap, 0, 0, size.width, size.height)
  return canvas.toDataURL(type, quality)
}

/** Reads and makes smaller one image file, in the window. */
export async function prepareImage(file: File): Promise<ChatImage> {
  const bitmap = await createImageBitmap(file)
  try {
    const size = fitWithin(bitmap.width, bitmap.height)
    const type = outputType(file.type)
    const dataUrl = await draw(bitmap, size, type, 0.9)
    const thumbnail = await draw(bitmap, thumbnailSize(bitmap.width, bitmap.height), "image/jpeg", 0.8)
    return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: file.name || `imatge.${IMAGE_TYPES[type]}`, mime: type, data: dataUrl.slice(dataUrl.indexOf(",") + 1), width: size.width, height: size.height, thumbnail }
  } finally { bitmap.close() }
}

/** What the chat shows of a message with images: its text without the «[Imatges adjuntes: …]» line, which
 * stays in the conversation for the model (the images themselves are shown above the text). */
export function withoutImageNote(text: string): string {
  return text.replace(/\n*\[Imatges adjuntes: [^\]\n]*\]\s*$/, "")
}
