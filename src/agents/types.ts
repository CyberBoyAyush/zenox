import type { AgentConfig } from "@opencode-ai/sdk";

export type AgentFactory = (model?: string) => AgentConfig;

export type BuiltinAgentName =
  | "explorer"
  | "librarian"
  | "oracle"
  | "ui-planner";

export type AgentOverrideConfig = Partial<AgentConfig> & {
  prompt_append?: string;
  variant?: string;
};

export type AgentOverrides = Partial<
  Record<BuiltinAgentName, AgentOverrideConfig>
>;
