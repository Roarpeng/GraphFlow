export interface ProviderTextRequest {
  prompt: string;
  model: string;
}

export async function openaiGenerateText(request: ProviderTextRequest): Promise<string> {
  return `[openai:${request.model}] ${request.prompt}`;
}
