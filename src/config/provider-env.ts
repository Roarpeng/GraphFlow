import type { GraphFlowConfig, ProviderConfig } from "./schema";
import { resolveConfigSecret } from "./secrets";

const PROVIDER_ENV_MAP = {
  openai: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" },
  anthropic: { apiKey: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL" },
  bailian: { apiKey: "BAILIAN_API_KEY", baseUrl: "BAILIAN_BASE_URL" },
  doubao: { apiKey: "DOUBAO_API_KEY", baseUrl: "DOUBAO_BASE_URL" },
  deepseek: { apiKey: "DEEPSEEK_API_KEY", baseUrl: "DEEPSEEK_BASE_URL" },
} as const;

export type ProviderEnvName = keyof typeof PROVIDER_ENV_MAP;

/**
 * Apply configured provider credentials into process.env for adapters that
 * read OPENAI_API_KEY / DEEPSEEK_API_KEY (and related base URL vars).
 * Existing env values always win.
 */
export function applyProviderEnvFromConfig(config: GraphFlowConfig): string[] {
  const applied: string[] = [];

  for (const [name, envNames] of Object.entries(PROVIDER_ENV_MAP) as Array<
    [ProviderEnvName, (typeof PROVIDER_ENV_MAP)[ProviderEnvName]]
  >) {
    const details = config.providers[name] as ProviderConfig | undefined;
    if (!details) {
      continue;
    }

    const apiKey = resolveConfigSecret(details.apiKey);
    if (apiKey && !process.env[envNames.apiKey]?.trim()) {
      process.env[envNames.apiKey] = apiKey;
      applied.push(envNames.apiKey);
    }

    const baseUrl = details.baseUrl?.trim();
    if (baseUrl && !process.env[envNames.baseUrl]?.trim()) {
      process.env[envNames.baseUrl] = baseUrl.replace(/\/+$/, "");
      applied.push(envNames.baseUrl);
    }
  }

  // Convenience: if openai points at DeepSeek but deepseek env is empty, mirror key.
  const openai = config.providers.openai;
  const openaiBase = openai?.baseUrl?.toLowerCase() ?? "";
  if (openaiBase.includes("deepseek.com")) {
    const key = resolveConfigSecret(openai?.apiKey);
    if (key && !process.env.DEEPSEEK_API_KEY?.trim()) {
      process.env.DEEPSEEK_API_KEY = key;
      applied.push("DEEPSEEK_API_KEY");
    }
    if (!process.env.DEEPSEEK_BASE_URL?.trim()) {
      process.env.DEEPSEEK_BASE_URL = (openai?.baseUrl ?? "https://api.deepseek.com").replace(
        /\/+$/,
        ""
      );
      applied.push("DEEPSEEK_BASE_URL");
    }
  }

  return applied;
}
