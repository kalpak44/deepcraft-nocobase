import type { Application } from "@nocobase/server"
import { z } from "zod"
import { transcribeAudio } from "./services/transcribe"
import { listProviders } from "./providers/registry"

/**
 * Register a `transcribeAudio` AI-callable tool with plugin-ai's toolsManager.
 *
 * Shape follows the runtime contract used by NocoBase's own `docs.js` and
 * `workflow-caller.js` (not the misleading `tool-manager.d.ts`) — the same
 * contract plugin-google-connector uses:
 *
 *   {
 *     scope: 'GENERAL' | 'SPECIFIED' | 'CUSTOM',
 *     from: 'loader' | 'workflow',
 *     defaultPermission?: 'ALLOW' | 'DENY',
 *     introduction: { title, about },
 *     definition: { name, description, schema (zod) },
 *     invoke: async (ctx, args) => ({ status, content }),
 *   }
 *
 * The UI listBinding filter (aiTools.js:73) shows only:
 *   tool.scope === 'GENERAL' && tool.from === 'loader'
 * under "General tools" — so we set both.
 */
export function registerAITools(app: Application): void {
  const aiPlugin: any = safeGet(app, "ai")
  const toolsManager: any =
    aiPlugin?.aiManager?.toolsManager ||
    aiPlugin?.ai?.toolsManager ||
    (app as any).aiManager?.toolsManager
  if (!toolsManager || typeof toolsManager.registerTools !== "function") {
    app.logger?.info?.(
      "[noco-transcribe] plugin-ai not detected; skipping AI tool registration. REST endpoint remains available.",
    )
    return
  }

  const success = (data: unknown) => ({
    status: "success" as const,
    content: JSON.stringify(data),
  })
  const failure = (err: unknown) => ({
    status: "error" as const,
    content: err instanceof Error ? err.message : String(err),
  })

  const schema = z.object({
    audioUrl: z
      .string()
      .url()
      .optional()
      .describe("A fetchable URL to the audio file (e.g. a NocoBase attachment URL)."),
    audioBase64: z
      .string()
      .optional()
      .describe(
        "Inline base64-encoded audio bytes. Provide exactly one of audioUrl or audioBase64.",
      ),
    filename: z.string().optional().describe('Optional filename hint, e.g. "clip.mp3".'),
    mimeType: z.string().optional().describe('Optional MIME type hint, e.g. "audio/mpeg".'),
    provider: z
      .enum(listProviders() as [string, ...string[]])
      .optional()
      .describe("Transcription provider to use. Defaults to the configured default."),
    model: z
      .string()
      .optional()
      .describe('Provider-specific model override, e.g. "gpt-4o-mini-transcribe" or "whisper-1".'),
    language: z
      .string()
      .optional()
      .describe(
        "ISO-639-1 language of the speech, e.g. \"bg\", \"ru\", \"en\". LEAVE THIS UNSET unless " +
          "the user has actually told you what language the recording is in. It is not a hint: " +
          "it tells the decoder what the audio is, so guessing wrong produces confident nonsense " +
          "rather than an error — a Bulgarian recording labelled \"en\" comes back as " +
          "English-sounding gibberish. Omitted, the whisper server detects the language itself.",
      ),
    prompt: z
      .string()
      .optional()
      .describe("Optional context/prompt to guide transcription (e.g. expected vocabulary)."),
  })

  const tool = {
    scope: "GENERAL" as const,
    from: "loader" as const,
    defaultPermission: "ALLOW" as const,
    introduction: {
      title: "Transcribe audio",
      about:
        "Transcribe an audio file (by URL or inline base64) to text using a configured transcription provider.",
    },
    definition: {
      name: "transcribeAudio",
      description:
        "Transcribe spoken audio to text. Accepts either a fetchable audioUrl or inline audioBase64. Returns the transcript text.",
      schema,
    },
    invoke: async (_ctx: any, args: any) => {
      try {
        return success(await transcribeAudio(app, args || {}))
      } catch (e) {
        return failure(e)
      }
    },
  }

  try {
    toolsManager.registerTools([tool])
    app.logger?.info?.(
      "[noco-transcribe] Registered transcribeAudio AI tool (scope=GENERAL, from=loader).",
    )
  } catch (err: any) {
    app.logger?.warn?.(`[noco-transcribe] Failed to register AI tool: ${err?.message || err}`)
  }
}

function safeGet(app: Application, name: string): any {
  try {
    return app.pm?.get?.(name)
  } catch {
    return undefined
  }
}
