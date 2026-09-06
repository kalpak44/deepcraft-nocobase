import type { TranscriptionProvider } from "./types"
import { OpenAITranscriptionProvider } from "./openai"
import { WhisperTranscriptionProvider } from "./whisper"

const PROVIDERS: Record<string, TranscriptionProvider> = {
  openai: OpenAITranscriptionProvider,
  whisper: WhisperTranscriptionProvider,
}

export function getProvider(name: string): TranscriptionProvider {
  const provider = PROVIDERS[name]
  if (!provider) {
    throw new Error(
      `Unknown transcription provider "${name}". Available providers: ${Object.keys(PROVIDERS).join(", ")}.`,
    )
  }
  return provider
}

export function listProviders(): string[] {
  return Object.keys(PROVIDERS)
}
