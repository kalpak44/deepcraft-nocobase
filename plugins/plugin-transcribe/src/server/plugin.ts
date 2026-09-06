import { Plugin } from "@nocobase/server"
import { transcribeAudio } from "./services/transcribe"
import {
  resolveTranscriptionConfig,
  getProviderApiKey,
  isProviderEnabled,
  setProviderEnabled,
} from "./services/config"
import { listProviders, getProvider } from "./providers/registry"
import { registerAITools } from "./ai-tools"

// NocoBase's resourcer nests POST body fields under `ctx.action.params.values`
// for some custom actions but leaves them flat on `ctx.action.params` for
// others (observed empirically, not documented) — read both so callers don't
// need to know which convention a given action name triggers.
function getActionBody(ctx: any): Record<string, any> {
  const params = ctx.action?.params || {}
  return { ...params, ...(params.values || {}) }
}

export class PluginNocoTranscribeServer extends Plugin {
  async load() {
    this.app.acl.allow("transcription", "*", "loggedIn")

    this.app.resourceManager.define({
      name: "transcription",
      actions: {
        transcribe: async (ctx, next) => {
          const { audioUrl, audioBase64, filename, mimeType, provider, model, language, prompt } =
            getActionBody(ctx)
          if (!audioUrl && !audioBase64) {
            ctx.throw(400, "Provide exactly one of `audioUrl` or `audioBase64`.")
          }
          ctx.body = await transcribeAudio(this.app, {
            audioUrl,
            audioBase64,
            filename,
            mimeType,
            provider,
            model,
            language,
            prompt,
          })
          await next()
        },
        configStatus: async (ctx, next) => {
          const config = resolveTranscriptionConfig(this.app)
          const providers: Record<
            string,
            { configured: boolean; enabled: boolean; defaultModel: string | null; message?: string }
          > = {}
          for (const name of listProviders()) {
            const enabled = isProviderEnabled(this.app, name)
            const provider = getProvider(name)
            // transcribe_default_model is a global override attempted for whichever
            // provider is used (matches services/transcribe.ts's own resolution:
            // args.model || config.defaultModel, with the provider filling in its
            // own default if still empty). Providers that ignore the model field
            // entirely (e.g. whisper, fixed server-side) report null.
            const defaultModel = config.defaultModel || provider.defaultModel || null
            if (provider.requiresApiKey === false) {
              providers[name] = { configured: true, enabled, defaultModel }
              continue
            }
            try {
              getProviderApiKey(this.app, name)
              providers[name] = { configured: true, enabled, defaultModel }
            } catch (err: any) {
              providers[name] = {
                configured: false,
                enabled,
                defaultModel,
                message: err?.message || String(err),
              }
            }
          }
          ctx.body = {
            configured: providers[config.defaultProvider]?.configured ?? false,
            defaultProvider: config.defaultProvider,
            defaultModel: config.defaultModel,
            message: providers[config.defaultProvider]?.message,
            providers,
          }
          await next()
        },
        setProviderEnabled: async (ctx, next) => {
          const { provider, enabled: rawEnabled } = getActionBody(ctx)
          const enabled = typeof rawEnabled === "string" ? rawEnabled === "true" : rawEnabled
          if (!provider || typeof enabled !== "boolean") {
            ctx.throw(400, "Provide `provider` (string) and `enabled` (boolean).")
          }
          getProvider(provider) // throws if unknown
          await setProviderEnabled(this.app, provider, enabled)
          ctx.body = { provider, enabled }
          await next()
        },
      },
    })

    registerAITools(this.app)
  }
}

export default PluginNocoTranscribeServer
