export interface ControlPlaneConfig {
  mode: "api" | "lease";
  port: number;
  host: string;
  environment: "development" | "test" | "production";
  operatorCredential: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  publicOrigin?: string;
  secureCookies: boolean;
  demoSourceId: string;
  demoSourceUrl: string;
  storageBucket?: string;
  retentionHours: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const runtimeEnvironment = parseEnvironment(environment.NODE_ENV);
  const production = runtimeEnvironment === "production";
  const operatorCredential =
    environment.OPERATOR_CREDENTIAL ?? (production ? "" : "vigil-local-owner");
  const sessionSecret =
    environment.SESSION_SECRET ??
    (production ? "" : "local-only-session-secret-change-before-deploying");

  if (operatorCredential.length < 12) {
    throw new Error("OPERATOR_CREDENTIAL must contain at least 12 characters");
  }
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }

  const demoSourceUrl =
    environment.DEMO_SOURCE_URL ?? "http://synthetic-hls:8080/live/index.m3u8";
  const source = new URL(demoSourceUrl);
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
    throw new Error("DEMO_SOURCE_URL must be an HTTP(S) URL without embedded credentials");
  }

  const publicOrigin = environment.PUBLIC_ORIGIN?.replace(/\/$/, "");
  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    if (production && origin.protocol !== "https:") {
      throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
    }
  }

  return {
    mode: environment.SERVICE_MODE === "lease" ? "lease" : "api",
    port: Number(environment.PORT ?? (environment.SERVICE_MODE === "lease" ? "8080" : "3000")),
    host: environment.HOST ?? "0.0.0.0",
    environment: runtimeEnvironment,
    operatorCredential,
    sessionSecret,
    sessionTtlSeconds: Number(environment.SESSION_TTL_SECONDS ?? "1800"),
    ...(publicOrigin ? { publicOrigin } : {}),
    secureCookies: production,
    demoSourceId: environment.DEMO_SOURCE_ID ?? "synthetic-hls",
    demoSourceUrl,
    ...(environment.STORAGE_BUCKET ? { storageBucket: environment.STORAGE_BUCKET } : {}),
    retentionHours: Number(environment.RETENTION_HOURS ?? "24"),
  };
}

function parseEnvironment(value: string | undefined): ControlPlaneConfig["environment"] {
  if (value === "production" || value === "test") {
    return value;
  }
  return "development";
}

