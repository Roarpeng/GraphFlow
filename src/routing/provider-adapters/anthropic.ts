import type { ProviderTextRequest } from "./openai";

export async function anthropicGenerateText(request: ProviderTextRequest): Promise<string> {
  return `[anthropic:${request.model}] ${request.prompt}`;
}
