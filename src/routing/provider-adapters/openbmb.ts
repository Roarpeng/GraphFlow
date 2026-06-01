export interface ProviderTextRequest {
  prompt: string;
  model: string;
}

export async function openbmbGenerateText(request: ProviderTextRequest): Promise<string> {
  return `[openbmb:${request.model}] ${request.prompt}`;
}
