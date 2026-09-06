import type {
  ProviderCredentials,
  TranscribeInput,
  TranscribeResult,
  TranscriptionProvider,
} from "./types"

// whisper's built-in `server` example (tools/server in the whisper repo).
// Its API is its own, not OpenAI-compatible: a single POST /inference
// with a multipart `file` field, no `model` field (the model is fixed at
// server startup via --model) and no authentication.
export const WhisperTranscriptionProvider: TranscriptionProvider = {
  name: "whisper",
  defaultModel: "",
  defaultBaseUrl: "http://127.0.0.1:9001",
  requiresApiKey: false,

  async transcribe(
    input: TranscribeInput,
    credentials: ProviderCredentials,
  ): Promise<TranscribeResult> {
    const baseUrl = (credentials.baseUrl || WhisperTranscriptionProvider.defaultBaseUrl).replace(
      /\/+$/,
      "",
    )

    const form = new FormData()
    form.append(
      "file",
      new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }),
      input.filename,
    )
    form.append("response_format", "json")
    if (input.language) form.append("language", input.language)
    if (input.prompt) form.append("prompt", input.prompt)

    const res = await fetch(`${baseUrl}/inference`, {
      method: "POST",
      body: form,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`whisper transcription failed (${res.status}): ${body}`)
    }

    const json = (await res.json()) as { text: string }
    return {
      text: (json.text || "").trim(),
      provider: WhisperTranscriptionProvider.name,
      model: "whisper (model fixed by the server)",
      language: input.language,
    }
  },
}

export default WhisperTranscriptionProvider
