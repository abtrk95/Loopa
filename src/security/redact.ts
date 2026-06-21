/**
 * Secret redaction. Applied to everything that could be persisted or shown:
 * process output, event payloads, logs, error messages, and dashboard text.
 *
 * Two layers:
 *  1. Pattern-based: well-known credential shapes (provider keys, cloud keys,
 *     private-key blocks, bearer tokens).
 *  2. Literal-value: exact secret strings discovered in the environment (see
 *     security/env.ts) are masked wherever they appear, even partial overlaps.
 */

export const REDACTION_PLACEHOLDER = '***REDACTED***';

/** Credential-shaped patterns. Ordered roughly by specificity. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic style
  /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g, // Anthropic API key (explicit)
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret/restricted/publishable
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub PAT (classic)
  /gh[osur]_[A-Za-z0-9]{20,}/g, // GitHub other tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /npm_[A-Za-z0-9]{30,}/g, // npm automation token
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ASIA[0-9A-Z]{16}/g, // AWS temporary access key id
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /\bBearer\s+[A-Za-z0-9._-]{16,}/g, // Authorization: Bearer ...
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A reusable redactor. Construct with the set of literal secret values to mask
 * (typically the values of secret-bearing environment variables) and call
 * `redact` on any string before it leaves the process boundary.
 */
export class Redactor {
  private readonly literals: RegExp[];

  constructor(literalSecrets: readonly string[] = []) {
    // Only mask non-trivial values to avoid nuking common short strings.
    this.literals = [...new Set(literalSecrets)]
      .filter((v) => v.length >= 6)
      .map((v) => new RegExp(escapeRegExp(v), 'g'));
  }

  redact(input: string): string {
    if (!input) return input;
    let out = input;
    for (const re of this.literals) {
      out = out.replace(re, REDACTION_PLACEHOLDER);
    }
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, REDACTION_PLACEHOLDER);
    }
    return out;
  }
}

/** Stateless one-shot redaction using only the built-in patterns. */
export function redact(input: string): string {
  return new Redactor().redact(input);
}
