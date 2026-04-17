/**
 * Keyword Detector Hook
 *
 * Detects special keywords in user messages and:
 * 1. Injects mode-specific context into the message
 * 2. Shows toast notification for user feedback
 *
 * Uses the "chat.message" hook which fires when user submits a message.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { VariantMessage } from "../../shared"
import { KEYWORD_CONFIGS, type KeywordConfig } from "./contexts"

const TOAST_DURATION = 4000

interface MessagePart {
  type: string
  text?: string
  synthetic?: boolean
}

interface ChatMessageOutput {
  parts: MessagePart[]
  message: VariantMessage
}

function extractTextFromParts(parts: MessagePart[]): string {
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text ?? "")
    .join(" ")
}

function removeCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "")
}

function detectKeywords(text: string): KeywordConfig[] {
  const cleanText = removeCodeBlocks(text)
  const detected: KeywordConfig[] = []

  for (const config of KEYWORD_CONFIGS) {
    if (config.pattern.test(cleanText)) {
      detected.push(config)
    }
  }

  return detected
}

export function createKeywordDetectorHook(ctx: PluginInput) {
  const detectedSessions = new Set<string>()

  return {
    "chat.message": async (
      input: { sessionID: string; agent?: string },
      output: ChatMessageOutput
    ): Promise<void> => {
      const promptText = extractTextFromParts(output.parts)
      const detectedKeywords = detectKeywords(promptText)

      if (detectedKeywords.length === 0) return

      // Prevent duplicate detection in same session
      const sessionKey = `${input.sessionID}-${detectedKeywords.map((k) => k.type).join("-")}`
      if (detectedSessions.has(sessionKey)) return
      detectedSessions.add(sessionKey)

      // Get highest priority keyword (ultrawork > deep-research > explore)
      const primaryKeyword = detectedKeywords[0]

      // Inject context by appending to existing text part or adding new one
      const textPartIndex = output.parts.findIndex((p) => p.type === "text" && p.text)
      
      if (textPartIndex >= 0) {
        // Append context to existing text part
        const existingPart = output.parts[textPartIndex]
        existingPart.text = `${existingPart.text ?? ""}\n\n${primaryKeyword.context}`
      } else {
        // Add new text part if none exists
        output.parts.push({
          type: "text",
          text: primaryKeyword.context,
          synthetic: true,
        })
      }

      // Show toast notification
      await ctx.client.tui
        .showToast({
          body: {
            title: primaryKeyword.toast.title,
            message: primaryKeyword.toast.message,
            variant: "success",
            duration: TOAST_DURATION,
          },
        })
        .catch(() => {})

      // Clean up old session keys periodically (prevent memory leak)
      if (detectedSessions.size > 100) {
        const entries = [...detectedSessions]
        entries.slice(0, 50).forEach((key) => detectedSessions.delete(key))
      }
    },
  }
}

export { KEYWORD_CONFIGS, type KeywordType, type KeywordConfig } from "./contexts"
