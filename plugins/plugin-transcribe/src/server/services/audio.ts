const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // OpenAI's audio transcription upload limit.

export interface AudioInputArgs {
  audioUrl?: string
  audioBase64?: string
  filename?: string
  mimeType?: string
}

export interface ResolvedAudio {
  buffer: Buffer
  filename: string
  mimeType: string
}

export async function resolveAudioInput(args: AudioInputArgs): Promise<ResolvedAudio> {
  const hasUrl = !!args.audioUrl
  const hasBase64 = !!args.audioBase64

  if (hasUrl === hasBase64) {
    throw new Error("Provide exactly one of audioUrl or audioBase64.")
  }

  if (hasUrl) {
    const res = await fetch(args.audioUrl!)
    if (!res.ok) {
      throw new Error(`Failed to fetch audioUrl (${res.status} ${res.statusText}).`)
    }
    const contentLength = res.headers.get("content-length")
    if (contentLength && Number(contentLength) > MAX_AUDIO_BYTES) {
      throw new Error(`Audio file too large: ${contentLength} bytes (max ${MAX_AUDIO_BYTES}).`)
    }
    const arrayBuffer = await res.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(
        `Audio file too large: ${arrayBuffer.byteLength} bytes (max ${MAX_AUDIO_BYTES}).`,
      )
    }
    return {
      buffer: Buffer.from(arrayBuffer),
      filename: args.filename || filenameFromUrl(args.audioUrl!) || "audio.mp3",
      mimeType: args.mimeType || res.headers.get("content-type") || "audio/mpeg",
    }
  }

  const buffer = Buffer.from(args.audioBase64!, "base64")
  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`Audio data too large: ${buffer.byteLength} bytes (max ${MAX_AUDIO_BYTES}).`)
  }
  return {
    buffer,
    filename: args.filename || "audio.mp3",
    mimeType: args.mimeType || "audio/mpeg",
  }
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname
    const last = path.split("/").pop()
    return last || undefined
  } catch {
    return undefined
  }
}
