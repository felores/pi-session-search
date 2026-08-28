const OPERATOR_PATTERN = /\b(OR|AND|NOT|NEAR)\b/;
const TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const CONNECTORS = new Set(["and", "or", "not", "near"]);

export function hasExplicitFts5Operator(query: string): boolean {
  return OPERATOR_PATTERN.test(query.trim());
}

function terms(query: string): string[] {
  const result: string[] = [];
  for (const match of query.matchAll(TOKEN_PATTERN)) {
    const phrase = match[1];
    const token = match[2];
    if (phrase === undefined && token && CONNECTORS.has(token.toLowerCase())) continue;
    const value = phrase ?? token ?? "";
    if (value) result.push(value);
  }
  return result;
}

function quote(values: string[], separator: string): string {
  return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(separator);
}

export function normalizeFts5Query(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  return hasExplicitFts5Operator(trimmed) ? trimmed : quote(terms(trimmed), " ");
}

export function fallbackFts5Query(query: string, ignoreOperators = false): string | null {
  const trimmed = query.trim();
  if (!trimmed || (!ignoreOperators && hasExplicitFts5Operator(trimmed))) return null;
  const values = terms(trimmed);
  return values.length > 1 ? quote(values, " OR ") : null;
}

export function naturalLanguageFts5Query(query: string): string {
  return quote(terms(query.trim()), " ");
}

export function naturalLanguageTerms(query: string): string[] {
  return terms(query.trim());
}

export function isFts5QueryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("fts5") || message.includes("unterminated string");
}
