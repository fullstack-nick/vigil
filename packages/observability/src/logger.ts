export type LogLevel = "debug" | "info" | "warn" | "error";

const redactedKeys = new Set([
  "authorization",
  "cookie",
  "credential",
  "database_url",
  "db_password",
  "operator_credential",
  "session_secret",
  "signed_url",
  "source_url",
  "token",
]);

export function log(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      redactedKeys.has(key.toLowerCase()) ? "[REDACTED]" : sanitize(value),
    ]),
  );
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    severity: level.toUpperCase(),
    service: process.env.SERVICE_NAME ?? "vigil",
    message,
    ...safeFields,
  });
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

function sanitize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.search) {
        return `${url.origin}${url.pathname}?[REDACTED]`;
      }
    } catch {
      // It was not a URL.
    }
  }
  return value;
}

