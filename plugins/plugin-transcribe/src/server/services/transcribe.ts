import type { Application } from "@nocobase/server"
import {
  resolveTranscriptionConfig,
  getProviderApiKey,
  getProviderBaseUrl,
  isProviderEnabled,
} from "./config"
import { resolveAudioInput, type AudioInputArgs } from "./audio"
import { getProvider } from "../providers/registry"
import type { TranscribeResult } from "../providers/types"

export interface TranscribeArgs extends AudioInputArgs {
  provider?: string
  model?: string
  language?: string
  prompt?: string
}

export async function transcribeAudio(
  app: Application,
  args: TranscribeArgs,
): Promise<TranscribeResult> {
  const config = resolveTranscriptionConfig(app)
  const providerName = args.provider || config.defaultProvider
  const provider = getProvider(providerName)
  if (!isProviderEnabled(app, providerName)) {
    throw new Error(
      `Transcription provider "${providerName}" is disabled. Enable it in Settings → Transcription, ` +
        `or choose a different provider.`,
    )
  }
  const apiKey =
    provider.requiresApiKey === false
      ? getProviderApiKey(app, providerName, { required: false })
      : getProviderApiKey(app, providerName)
  const baseUrl = getProviderBaseUrl(app, providerName)

  const audio = await resolveAudioInput(args)

  return provider.transcribe(
    {
      buffer: audio.buffer,
      filename: audio.filename,
      mimeType: audio.mimeType,
      model: args.model || config.defaultModel,
      language: args.language,
      prompt: args.prompt,
    },
    { apiKey, baseUrl },
  )
}
