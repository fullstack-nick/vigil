import { GoogleAuth } from "google-auth-library";
import { Kafka, logLevel, type KafkaConfig } from "kafkajs";

import type { WorkerConfig } from "./config.js";

const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";

export function createKafka(config: WorkerConfig): Kafka {
  const kafkaConfig: KafkaConfig = {
    clientId: config.clientId,
    brokers: config.brokers,
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    retry: { retries: 8, initialRetryTime: 300, maxRetryTime: 15_000 },
    logLevel: logLevel.NOTHING,
  };
  if (config.kafkaAuthMode === "gcp-oauth") {
    kafkaConfig.ssl = true;
    kafkaConfig.sasl = {
      mechanism: "oauthbearer",
      oauthBearerProvider: createGoogleOAuthBearerProvider(config.kafkaPrincipal),
    };
  }
  return new Kafka(kafkaConfig);
}

function createGoogleOAuthBearerProvider(configuredPrincipal?: string) {
  const auth = new GoogleAuth({ scopes: [cloudPlatformScope] });
  return async (): Promise<{ value: string }> => {
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken =
      typeof tokenResponse === "string" ? tokenResponse : tokenResponse.token;
    if (!accessToken) {
      throw new Error("ADC did not return an access token for Managed Kafka");
    }
    const credentials = await auth.getCredentials();
    const principal = configuredPrincipal ?? credentials.client_email;
    if (!principal) {
      throw new Error(
        "KAFKA_PRINCIPAL is required when ADC cannot determine a service-account email",
      );
    }
    const expiryMillis = client.credentials.expiry_date ?? Date.now() + 50 * 60 * 1_000;
    const header = base64UrlJson({ typ: "JWT", alg: "GOOG_OAUTH2_TOKEN" });
    const payload = base64UrlJson({
      exp: Math.floor(expiryMillis / 1_000),
      iss: "Google",
      iat: Math.floor(Date.now() / 1_000),
      sub: principal,
    });
    return { value: `${header}.${payload}.${Buffer.from(accessToken).toString("base64url")}` };
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

