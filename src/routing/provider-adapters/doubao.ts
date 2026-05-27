import type { ProviderTextRequest } from "./openai";

export async function doubaoGenerateText(request: ProviderTextRequest): Promise<string> {
  return `[doubao:${request.model}] ${request.prompt}`;
}
