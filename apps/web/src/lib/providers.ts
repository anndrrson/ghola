import type { ProviderConfig } from "./types";

export const PROVIDERS: ProviderConfig[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
      { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
      { id: "o3-mini", name: "o3-mini" },
    ],
  },
  {
    id: "google",
    name: "Google",
    models: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
      { id: "gemini-2.0-pro", name: "Gemini 2.0 Pro" },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    models: [
      { id: "mistral-large-latest", name: "Mistral Large" },
      { id: "mistral-medium-latest", name: "Mistral Medium" },
      { id: "mistral-small-latest", name: "Mistral Small" },
    ],
  },
];

export function getProvider(id: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function getProviderColor(id: string): string {
  switch (id) {
    case "anthropic": return "#d4a04a";
    case "openai": return "#10a37f";
    case "google": return "#4285f4";
    case "mistral": return "#ff7000";
    default: return "#3da8ff";
  }
}
