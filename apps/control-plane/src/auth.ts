import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import type { ControlPlaneConfig } from "./config.js";

const cookieName = "vigil_operator";

interface SessionPayload {
  exp: number;
  csrf: string;
}

export interface OperatorSession {
  csrf: string;
  expiresAt: Date;
}

export function credentialMatches(expected: string, supplied: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

export function createSession(
  reply: FastifyReply,
  config: ControlPlaneConfig,
): OperatorSession {
  const payload: SessionPayload = {
    exp: Date.now() + config.sessionTtlSeconds * 1_000,
    csrf: randomBytes(24).toString("base64url"),
  };
  const token = signPayload(payload, config.sessionSecret);
  reply.setCookie(cookieName, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: config.secureCookies,
    maxAge: config.sessionTtlSeconds,
  });
  return { csrf: payload.csrf, expiresAt: new Date(payload.exp) };
}

export function clearSession(reply: FastifyReply, config: ControlPlaneConfig): void {
  reply.clearCookie(cookieName, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: config.secureCookies,
  });
}

export function readSession(
  request: FastifyRequest,
  config: ControlPlaneConfig,
): OperatorSession | null {
  const token = request.cookies[cookieName];
  if (!token) {
    return null;
  }
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    return null;
  }
  const expected = createHmac("sha256", config.sessionSecret).update(encoded).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (
      typeof payload.exp !== "number" ||
      payload.exp <= Date.now() ||
      typeof payload.csrf !== "string" ||
      payload.csrf.length < 20
    ) {
      return null;
    }
    return { csrf: payload.csrf, expiresAt: new Date(payload.exp) };
  } catch {
    return null;
  }
}

export function operatorGuard(config: ControlPlaneConfig) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!readSession(request, config)) {
      await reply.code(401).send({ error: "OPERATOR_AUTH_REQUIRED" });
    }
  };
}

export function mutationGuard(config: ControlPlaneConfig) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = readSession(request, config);
    if (!session) {
      await reply.code(401).send({ error: "OPERATOR_AUTH_REQUIRED" });
      return;
    }
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !constantStringEqual(csrf, session.csrf)) {
      await reply.code(403).send({ error: "CSRF_TOKEN_INVALID" });
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      const expectedOrigin = config.publicOrigin ?? `${request.protocol}://${request.headers.host}`;
      if (origin !== expectedOrigin) {
        await reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
      }
    }
  };
}

function signPayload(payload: SessionPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function constantStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

