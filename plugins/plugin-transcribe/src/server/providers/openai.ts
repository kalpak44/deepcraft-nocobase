import type {
  ProviderCredentials,
  TranscribeInput,
  TranscribeResult,
  TranscriptionProvider,
} from "./types"

export const OpenAITranscriptionProvider: TranscriptionProvider = {
  name: "openai",
  defaultModel: "gpt-4o-mini-transcribe",
  defaultBaseUrl: "https://api.openai.com/v1",

  async transcribe(
    input: TranscribeInput,
    credentials: ProviderCredentials,
  ): Promise<TranscribeResult> {
    const model = input.model || OpenAITranscriptionProvider.defaultModel
    const baseUrl = (credentials.baseUrl || OpenAITranscriptionProvider.defaultBaseUrl).replace(
      /\/+$/,
      "",
    )

    const form = new FormData()
    form.append(
      "file",
      new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }),
      input.filename,
    )
    form.append("model", model)
    if (input.language) form.append("language", input.language)
    if (input.prompt) form.append("prompt", input.prompt)

    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
      body: form,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      let message = body
      try {
        message = JSON.parse(body)?.error?.message || body
      } catch {
        // keep raw body
      }
      throw new Error(`OpenAI transcription failed (${res.status}): ${message}`)
    }

    const json = (await res.json()) as { text: string; language?: string }
    return {
      text: json.text,
      provider: OpenAITranscriptionProvider.name,
      model,
      language: json.language || input.language,
    }
  },
}

export default OpenAITranscriptionProvider
