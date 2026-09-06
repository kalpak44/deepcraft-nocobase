import type { Application } from "@nocobase/server"

// All config keys are namespaced under `transcribe_` / `TRANSCRIBE_` so they
// can't collide with another plugin's own `openai_api_key`-style variables.
const PREFIX = "transcribe"

export interface TranscriptionConfig {
  defaultProvider: string
  defaultModel?: string
}

export function resolveTranscriptionConfig(app: Application): TranscriptionConfig {
  const vars = readEnv(app)

  const defaultProvider =
    vars[`${PREFIX}_default_provider`] ||
    vars[`${PREFIX.toUpperCase()}_DEFAULT_PROVIDER`] ||
    process.env[`${PREFIX.toUpperCase()}_DEFAULT_PROVIDER`] ||
    "openai"

  const defaultModel =
    vars[`${PREFIX}_default_model`] ||
    vars[`${PREFIX.toUpperCase()}_DEFAULT_MODEL`] ||
    process.env[`${PREFIX.toUpperCase()}_DEFAULT_MODEL`] ||
    undefined

  return { defaultProvider, defaultModel }
}

export function getProviderApiKey(
  app: Application,
  providerName: string,
  options?: { required?: boolean },
): string {
  const vars = readEnv(app)
  const lower = providerName.toLowerCase()
  const upper = providerName.toUpperCase()

  const apiKey =
    vars[`${PREFIX}_${lower}_api_key`] ||
    vars[`${PREFIX.toUpperCase()}_${upper}_API_KEY`] ||
    process.env[`${PREFIX.toUpperCase()}_${upper}_API_KEY`]

  if (!apiKey) {
    if (options?.required === false) {
      return ""
    }
    throw new Error(
      `No API key configured for transcription provider "${providerName}". Define Secret \`${PREFIX}_${lower}_api_key\` in ` +
        `NocoBase → Settings → Variables and secrets, or set the ${PREFIX.toUpperCase()}_${upper}_API_KEY environment variable.`,
    )
  }

  return apiKey
}

export function getProviderBaseUrl(app: Application, providerName: string): string | undefined {
  const vars = readEnv(app)
  const lower = providerName.toLowerCase()
  const upper = providerName.toUpperCase()

  return (
    vars[`${PREFIX}_${lower}_base_url`] ||
    vars[`${PREFIX.toUpperCase()}_${upper}_BASE_URL`] ||
    process.env[`${PREFIX.toUpperCase()}_${upper}_BASE_URL`] ||
    undefined
  )
}

function readEnv(app: Application): Record<string, string> {
  const env: any = (app as any).environment
  if (env && typeof env.getVariables === "function") return env.getVariables() || {}
  return {}
}

function providerEnabledVarName(providerName: string): string {
  return `${PREFIX}_${providerName.toLowerCase()}_enabled`
}

export function isProviderEnabled(app: Application, providerName: string): boolean {
  const vars = readEnv(app)
  const raw =
    vars[providerEnabledVarName(providerName)] ??
    process.env[providerEnabledVarName(providerName).toUpperCase()]
  if (raw === undefined || raw === null || raw === "") {
    return true // enabled by default until explicitly turned off
  }
  return !["false", "0", "no", "off"].includes(String(raw).toLowerCase())
}

export async function setProviderEnabled(
  app: Application,
  providerName: string,
  enabled: boolean,
): Promise<void> {
  const repo = app.db.getRepository("environmentVariables")
  const name = providerEnabledVarName(providerName)
  const value = String(enabled)
  const existing = await repo.findOne({ filter: { name } })
  if (existing) {
    await existing.update({ value })
  } else {
    await repo.create({ values: { name, type: "default", value } })
  }
}
