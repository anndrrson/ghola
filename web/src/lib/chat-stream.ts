import { chatRelay } from "./api";
import type { ChatAgent, ChatMessageLocal } from "./types";

export async function streamChat(
  agent: ChatAgent,
  messages: ChatMessageLocal[],
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (error: Error) => void
): Promise<void> {
  const apiMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const stream = chatRelay(
    agent.provider,
    agent.model,
    agent.apiKey,
    apiMessages,
    agent.systemPrompt || undefined
  );

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(value);
    }
    onDone();
  } catch (e) {
    onError(e instanceof Error ? e : new Error(String(e)));
  }
}
