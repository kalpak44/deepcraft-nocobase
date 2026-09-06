export interface TranscribeInput {
  buffer: Buffer
  filename: string
  mimeType: string
  model?: string
  language?: string
  prompt?: string
}

export interface TranscribeResult {
  text: string
  provider: string
  model: string
  language?: string
}

export interface ProviderCredentials {
  apiKey: string
  baseUrl?: string
}

export interface TranscriptionProvider {
  name: string
  defaultModel: string
  defaultBaseUrl: string
  /** Set to false for self-hosted servers with no auth. Defaults to true. */
  requiresApiKey?: boolean
  transcribe(input: TranscribeInput, credentials: ProviderCredentials): Promise<TranscribeResult>
}
