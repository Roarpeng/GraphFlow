/**
 * Secret redaction at the dialogue write boundary (Conversation Graph 2.0).
 *
 * - Table-driven coverage of each secret class (assert redacted).
 * - False-positive suite (assert NOT redacted) — over-redaction would make
 *   the dialogue graph useless.
 * - The GRAPHFLOW_DIALOGUE_REDACT env escape hatch (default ON).
 * - End-to-end: recordDialogueTurn persists redacted node content AND
 *   serialised `record` metadata (what expandAnchor returns verbatim).
 *
 * Same in-memory GraphifyClient pattern as tests/dialogue-thread.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  isDialogueRedactionEnabled,
  parseDialogueTurn,
  recordDialogueTurn,
  redactSecrets,
} from "../src/learning/dialogue-thread";

// ───────────────────────── secret classes (must redact) ─────────────────────────

interface SecretCase {
  name: string;
  input: string;
  /** A fragment that must never survive redaction. */
  secret: string;
  marker: string;
}

const SECRET_CLASSES: SecretCase[] = [
  {
    name: "OpenAI-style key (sk-proj-)",
    input: "debug why sk-proj-FIXTUREONLYnotarealkey fails on /v1/chat",
    secret: "sk-proj-FIXTUREONLYnotarealkey",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "Anthropic-style key (sk-ant-)",
    input: "the model call used sk-ant-FIXTUREONLYnotarealkey and timed out",
    secret: "sk-ant-FIXTUREONLYnotarealkey",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "GitHub classic PAT (ghp_)",
    input: "clone with ghp_FIXTUREONLYnotarealtoken12 over https",
    secret: "ghp_FIXTUREONLYnotarealtoken12",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "GitHub fine-grained PAT (github_pat_)",
    input: "set GITHUB_TOKEN=github_pat_FIXTUREONLYnotarealpat123 in ci",
    secret: "github_pat_FIXTUREONLYnotarealpat123",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "GitHub OAuth token (gho_)",
    // Synthetic fixtures below: intentionally low entropy and shorter than the
    // real token shapes so GitHub push protection does not flag this test file.
    // Each still satisfies our own minimimum-length redactor patterns.
    input: "the device flow returned gho_FIXTUREONLYnotarealtoken123",
    secret: "gho_FIXTUREONLYnotarealtoken123",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "GitLab PAT (glpat-)",
    input: "push using glpat-FIXTUREONLYpat123 please",
    secret: "glpat-FIXTUREONLYpat123",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "Slack token (xoxb-)",
    // Synthetic fixture: deliberately NOT shaped like a real Slack token
    // (no digit groups) so GitHub push protection does not flag this test file.
    // It still matches our own redactor pattern /xox[baprs]-[A-Za-z0-9-]{8,}/.
    input: "bot auth: xoxb-FIXTUREONLY-not-a-real-token-value",
    secret: "xoxb-FIXTUREONLY-not-a-real-token-value",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "AWS access key id (AKIA…)",
    input: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE for the sync job",
    secret: "AKIAIOSFODNN7EXAMPLE",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "Google API key (AIza…)",
    input: "maps key AIzaFIXTUREONLYkey1234567890123456 leaked",
    secret: "AIzaFIXTUREONLYkey1234567890123456",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "Stripe live key (sk_live_)",
    input: "STRIPE_KEY=sk_live_FIXTUREkey12345 in the checkout env",
    secret: "sk_live_FIXTUREkey12345",
    marker: "[REDACTED:api-key]",
  },
  {
    name: "Authorization: Bearer header",
    input:
      "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' https://api.example.com/v1",
    secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    marker: "[REDACTED:bearer]",
  },
  {
    name: "bare bearer token",
    input: "retry with Bearer aB3xYz9LongOpaqueToken123 and it should pass",
    secret: "aB3xYz9LongOpaqueToken123",
    marker: "[REDACTED:bearer]",
  },
  {
    name: "standalone JWT in prose",
    input: "paste of eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456ghi789jkl from the log",
    secret: "eyJhbGciOiJIUzI1NiJ9",
    marker: "[REDACTED:bearer]",
  },
  {
    name: "PEM private key block",
    input:
      "here is the key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA9876543210abcdefghijklmnopqrstuvwxyz\n-----END RSA PRIVATE KEY-----\nthanks",
    secret: "MIIEowIBAAKCAQEA9876543210",
    marker: "[REDACTED:private-key]",
  },
  {
    name: "truncated PEM private key (no END line)",
    input: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkxAAAAmgEAAA",
    secret: "b3BlbnNzaC1rZXkx",
    marker: "[REDACTED:private-key]",
  },
  {
    name: "postgres connection string",
    input: "DATABASE_URL=postgres://admin:Sup3rPassw0rd@db.example.com:5432/app is failing",
    secret: "Sup3rPassw0rd",
    marker: "[REDACTED:connection-string]",
  },
  {
    name: "mysql connection string",
    input: "use mysql://root:pw12345678@10.0.0.4:3306/shop for the migration",
    secret: "pw12345678",
    marker: "[REDACTED:connection-string]",
  },
  {
    name: "mongodb+srv connection string",
    input: "MONGO=mongodb+srv://atlasUser:Atl4sPass@cluster0.mongodb.net/graphflow",
    secret: "Atl4sPass",
    marker: "[REDACTED:connection-string]",
  },
  {
    name: "redis connection string",
    input: "cache at redis://default:cachePw9876@cache.internal:6379/0",
    secret: "cachePw9876",
    marker: "[REDACTED:connection-string]",
  },
  {
    name: "amqp connection string",
    input: "broker: amqp://guest:gue55Pass@rabbit.local:5672/",
    secret: "gue55Pass",
    marker: "[REDACTED:connection-string]",
  },
  {
    name: ".env style KEY=value with credential-looking value",
    input: "OPENAI_API_KEY=aB3xYz9LongEnoughSecret123 goes in the shell profile",
    secret: "aB3xYz9LongEnoughSecret123",
    marker: "[REDACTED:credential]",
  },
  {
    name: "quoted client_secret keeps JSON valid",
    input: '{"client_secret": "GOCSPX-AbCdEf123456", "name": "demo"}',
    secret: "GOCSPX-AbCdEf123456",
    marker: "[REDACTED:credential]",
  },
  {
    name: "password pair",
    input: "DB_PASSWORD=hunter2hunter2 for the nightly job",
    secret: "hunter2hunter2",
    marker: "[REDACTED:credential]",
  },
  {
    name: "yaml token pair",
    input: "auth_token: 9f8e7d6c5b4a3210 # rotate me",
    secret: "9f8e7d6c5b4a3210",
    marker: "[REDACTED:credential]",
  },
  {
    name: "access-key pair with quoted value",
    input: "aws_secret_access_key = 'wJalrXUtnFEMI9K7ENGbPxRfiCYz123'",
    secret: "wJalrXUtnFEMI9K7ENGbPxRfiCYz123",
    marker: "[REDACTED:credential]",
  },
  {
    name: "multi-line .env paste",
    input: [
      "STRIPE_SECRET_KEY=sk_live_FIXTUREkey12345",
      "POSTGRES_URL=postgres://app:s3cr3tValue@10.0.0.5:5432/app",
      "SESSION_TOKEN=abcDEF123456789ghiJKL",
    ].join("\n"),
    secret: "s3cr3tValue",
    marker: "[REDACTED:connection-string]",
  },
];

describe("redactSecrets — secret classes", () => {
  it.each(SECRET_CLASSES)("redacts $name", ({ input, secret, marker }) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(marker);
  });

  it("keeps quoted JSON structurally valid after redaction", () => {
    const out = redactSecrets('{"client_secret": "GOCSPX-AbCdEf123456", "name": "demo"}');
    expect(JSON.parse(out)).toEqual({ client_secret: "[REDACTED:credential]", name: "demo" });
  });

  it("preserves non-secret context around the hit", () => {
    const out = redactSecrets("run curl -H 'Authorization: Bearer abcDEF123456789xyz' https://api.example.com");
    expect(out).toContain("Authorization:");
    expect(out).toContain("https://api.example.com");
    expect(out).toContain("[REDACTED:bearer]");
  });

  it("is idempotent and deterministic (markers never re-match)", () => {
    const dirty =
      "OPENAI_API_KEY=aB3xYz9Secret123 and Bearer eyJhbGciOiJ9.eyJzdWIiOjEyM30.abcDEF123456 plus postgres://u:p12345@h/db";
    const once = redactSecrets(dirty);
    expect(once).toContain("[REDACTED:credential]");
    expect(once).toContain("[REDACTED:bearer]");
    expect(once).toContain("[REDACTED:connection-string]");
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets(dirty)).toBe(once);
  });

  it("is fast enough for the per-turn write path (20 × ~4k chars)", () => {
    const text = "some ordinary prose about the dialogue graph. ".repeat(90) + " sk-proj-AbCdEf1234567890";
    expect(text.length).toBeGreaterThan(3_500);
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) {
      expect(redactSecrets(text)).toContain("[REDACTED:api-key]");
    }
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

// ───────────────────────── false positives (must NOT redact) ─────────────────────────

const FALSE_POSITIVES: Array<{ name: string; text: string }> = [
  {
    name: "ordinary prose containing the keywords",
    text: "The bearer of this message explained the token bucket algorithm and the password rotation policy.",
  },
  {
    name: "file paths and code identifiers",
    text: "Edit src/learning/dialogue-thread.ts and call recordDialogueTurn(client, input) from graphify-client.",
  },
  {
    name: "URLs without credentials",
    text: "See https://github.com/roarpeng/graphflow, redis://localhost:6379 and postgres://localhost/graphflow.",
  },
  {
    name: "version numbers",
    text: "GraphFlow v1.16.0 supersedes 1.15.0; mongodb+srv clusters need driver >= 4.2 and node 18.19.1.",
  },
  {
    name: "code expressions assigned to credential-named keys",
    text: "const apiKey = getApiKey(config.apiKey); process.env.OPENAI_API_KEY is read once at startup.",
  },
  {
    name: "short, numeric or placeholder values",
    text: "tokenizer = gpt4o, token_count: 1523, secret: none, api_key=undefined, password: <your-password>",
  },
  {
    name: "hyphenated words containing sk-",
    text: "task-management, desk-organization and flask-recipes are ordinary words, not keys.",
  },
  {
    name: "near-miss key shapes",
    text: "AKIAIOSFODN is too short, sk-short likewise, and xoxb-123 alone is not a token.",
  },
  {
    name: "CJK prose about the dialogue graph",
    text: "对话图谱把每轮问答写成 Decision 节点，token 预算由打包层控制，版本号 1.16.0 不含密钥。",
  },
  {
    name: "dotted identifier as pair value",
    text: "OPENAI_API_KEY=process.env.OPENAI_API_KEY in the documented example",
  },
];

describe("redactSecrets — false positives", () => {
  it.each(FALSE_POSITIVES)("leaves untouched: $name", ({ text }) => {
    expect(redactSecrets(text)).toBe(text);
  });
});

// ───────────────────────── env escape hatch ─────────────────────────

describe("GRAPHFLOW_DIALOGUE_REDACT escape hatch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to ON", () => {
    expect(isDialogueRedactionEnabled()).toBe(true);
    expect(redactSecrets("key AKIAIOSFODNN7EXAMPLE here")).toContain("[REDACTED:api-key]");
  });

  it.each(["0", "false", "off", "no", " FALSE "])("disables redaction when set to %s", (raw) => {
    vi.stubEnv("GRAPHFLOW_DIALOGUE_REDACT", raw);
    expect(isDialogueRedactionEnabled()).toBe(false);
    const dirty = "OPENAI_API_KEY=aB3xYz9Secret123 sk-proj-AbCdEf1234567890";
    expect(redactSecrets(dirty)).toBe(dirty);
  });

  it("keeps redaction for truthy values", () => {
    vi.stubEnv("GRAPHFLOW_DIALOGUE_REDACT", "1");
    expect(isDialogueRedactionEnabled()).toBe(true);
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:api-key]");
  });
});

// ───────────────────────── end-to-end write boundary ─────────────────────────

describe("recordDialogueTurn — secrets never reach the graph store", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redacts node content AND serialised record metadata", async () => {
    const client = new GraphifyClient();
    const result = await recordDialogueTurn(client, {
      userQuery:
        "Why does auth fail with OPENAI_API_KEY=aB3xYz9Secret123 and postgres://admin:Sup3rPassw0rd@db.internal:5432/app?",
      assistantReply:
        "Rotate the key, then call with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123DEF456ghi789jkl. " +
        "Never paste your PEM:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34E1234567890\n-----END RSA PRIVATE KEY-----",
      workspaceRoot: "/repo",
      now: 1_000,
    });

    expect(result.recorded).toBe(true);
    const secrets = [
      "aB3xYz9Secret123",
      "Sup3rPassw0rd",
      "eyJhbGciOiJIUzI1NiJ9",
      "MIIBOgIBAAJBAKj34E1234567890",
      "postgres://admin",
    ];

    // No secret anywhere in the persisted graph (content, metadata, session hub).
    for (const node of client.readSnapshot().nodes) {
      for (const secret of secrets) {
        expect(node.content).not.toContain(secret);
        expect(String(node.metadata?.record ?? "")).not.toContain(secret);
      }
    }

    // The returned record is redacted too (callers must not see raw secrets).
    for (const secret of secrets) {
      expect(result.turn?.userQuery).not.toContain(secret);
      expect(result.turn?.assistantReply).not.toContain(secret);
    }

    // Markers survive so the turn stays debuggable through expandAnchor reads.
    const turnNode = client.readSnapshot().nodes.find((node) => node.id === result.turn?.id)!;
    const record = String(turnNode.metadata?.record ?? "");
    expect(turnNode.content).toContain("[REDACTED:credential]");
    expect(turnNode.content).toContain("[REDACTED:connection-string]");
    expect(record).toContain("[REDACTED:bearer]");
    expect(record).toContain("[REDACTED:private-key]");

    const parsed = parseDialogueTurn(turnNode)!;
    expect(parsed.userQuery).toContain("[REDACTED:credential]");
    expect(parsed.assistantReply).toContain("[REDACTED:bearer]");
    expect(parsed.assistantReply).toContain("[REDACTED:private-key]");
  });

  it("persists raw text when the escape hatch disables redaction", async () => {
    vi.stubEnv("GRAPHFLOW_DIALOGUE_REDACT", "0");
    const client = new GraphifyClient();
    const result = await recordDialogueTurn(client, {
      userQuery: "rotate the key sk-proj-AbCdEf1234567890 now",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const turnNode = client.readSnapshot().nodes.find((node) => node.id === result.turn?.id)!;
    expect(turnNode.content).toContain("sk-proj-AbCdEf1234567890");
    expect(String(turnNode.metadata?.record ?? "")).toContain("sk-proj-AbCdEf1234567890");
  });
});
