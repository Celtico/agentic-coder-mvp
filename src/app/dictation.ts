// Dictation in the window: what the microphone records (MediaRecorder) is decoded, mixed to one channel,
// resampled to 16 kHz and written as a 16-bit WAV, the form the local transcription reads without ffmpeg
// (src/electron/dictation.cjs, src/core/assistant/mlx_dictation.py).

export const DICTATION_RATE = 16000
/** A recording stops by itself after five minutes. */
export const MAX_RECORDING_MS = 5 * 60_000

/** One channel from several: their average, sample by sample. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const length = Math.min(...channels.map((channel) => channel.length))
  const mono = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[index]
    mono[index] = sum / channels.length
  }
  return mono
}

/** A 16-bit PCM mono WAV of the samples (clipped to [-1, 1]). */
export function encodeWav(samples: Float32Array, rate = DICTATION_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)) }
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE")
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, "data"); view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }
  return buffer
}

export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/** The dictated text added to what is already written, with one space between them. */
export const appendDictation = (draft: string, text: string) => !text.trim() ? draft : !draft.trim() ? text.trim() : `${draft.replace(/\s+$/, "")} ${text.trim()}`

/** A recording (any format the window can decode) as a 16 kHz mono WAV. */
export async function recordingToWav(blob: Blob): Promise<ArrayBuffer> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const length = Math.max(1, Math.ceil(decoded.duration * DICTATION_RATE))
    const offline = new OfflineAudioContext(1, length, DICTATION_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return encodeWav(mixToMono([rendered.getChannelData(0)]))
  } finally { await context.close().catch(() => {}) }
}
