/**
 * Keyword Detector Hook
 *
 * Detects special keywords in user messages and:
 * 1. Injects mode-specific context into the message
 * 2. Shows toast notification for user feedback
 *
 * Uses the V2 `session.hook("prompt")` admission hook.
 */

import type { ToastSink } from "../../shared/toast"
import { KEYWORD_CONFIGS, type KeywordConfig } from "./contexts"

const TOAST_DURATION = 4000

/** The mutable slice of a V2 `session.hook("prompt")` event this hook needs. */
export interface KeywordPromptEvent {
  readonly sessionID: string
  prompt: { text: string }
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

export function createKeywordDetectorHook(toast: ToastSink) {
  const detectedSessions = new Set<string>()

  /** Runs on prompt admission; appends the mode context to the prompt text. */
  return (event: KeywordPromptEvent): void => {
    const detectedKeywords = detectKeywords(event.prompt.text)
    if (detectedKeywords.length === 0) return

    // Prevent duplicate injection of the same mode(s) in one session
    const sessionKey = `${event.sessionID}-${detectedKeywords.map((k) => k.type).join("-")}`
    if (detectedSessions.has(sessionKey)) return
    detectedSessions.add(sessionKey)

    // Highest priority keyword wins (config order)
    const primaryKeyword = detectedKeywords[0]

    // Appending keeps any attachment mention offsets in the original text valid.
    event.prompt.text = event.prompt.text
      ? `${event.prompt.text}\n\n${primaryKeyword.context}`
      : primaryKeyword.context

    toast({
      title: primaryKeyword.toast.title,
      message: primaryKeyword.toast.message,
      variant: "success",
      duration: TOAST_DURATION,
      sessionID: event.sessionID,
    })

    // Bound memory
    if (detectedSessions.size > 100) {
      const entries = [...detectedSessions]
      entries.slice(0, 50).forEach((key) => detectedSessions.delete(key))
    }
  }
}

export { KEYWORD_CONFIGS, type KeywordType, type KeywordConfig } from "./contexts"
