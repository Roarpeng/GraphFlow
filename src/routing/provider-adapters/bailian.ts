import type { ProviderTextRequest } from "./openai";

export async function bailianGenerateText(request: ProviderTextRequest): Promise<string> {
  return `[bailian:${request.model}] ${request.prompt}`;
}
