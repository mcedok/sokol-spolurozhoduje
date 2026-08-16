import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";

export interface SecretService {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, encodedHash: string): Promise<boolean>;
  newOtp(): string;
  hashOtp(challengeId: string, code: string): string;
  verifyOtp(challengeId: string, code: string, expectedHash: string): boolean;
  newSessionToken(): string;
  hashSessionToken(token: string): string;
  newCsrfToken(): string;
  hashCsrfToken(token: string): string;
}

export interface SecretServiceConfig {
  sessionHmacKey: string;
  otpHmacKey: string;
  csrfHmacKey: string;
}

function assertStrongKey(name: string, value: string): void {
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
}

function hmac(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createSecretService(config: SecretServiceConfig): SecretService {
  assertStrongKey("SESSION_HMAC_KEY", config.sessionHmacKey);
  assertStrongKey("OTP_HMAC_KEY", config.otpHmacKey);
  assertStrongKey("CSRF_HMAC_KEY", config.csrfHmacKey);

  return {
    hashPassword(password) {
      return hash(password, {
        algorithm: Algorithm.Argon2id,
        memoryCost: 65_536,
        timeCost: 3,
        parallelism: 1,
      });
    },
    verifyPassword(password, encodedHash) {
      return verify(encodedHash, password);
    },
    newOtp() {
      const range = 1_000_000;
      const upperBound = Math.floor(0x1_000_000 / range) * range;
      while (true) {
        const bytes = randomBytes(3);
        const candidate = bytes.readUIntBE(0, 3);
        if (candidate < upperBound) return String(candidate % range).padStart(6, "0");
      }
    },
    hashOtp(challengeId, code) {
      return hmac(config.otpHmacKey, `${challengeId}:${code}`);
    },
    verifyOtp(challengeId, code, expectedHash) {
      return equalHex(hmac(config.otpHmacKey, `${challengeId}:${code}`), expectedHash);
    },
    newSessionToken() {
      return randomBytes(32).toString("base64url");
    },
    hashSessionToken(token) {
      return hmac(config.sessionHmacKey, token);
    },
    newCsrfToken() {
      return randomBytes(32).toString("base64url");
    },
    hashCsrfToken(token) {
      return hmac(config.csrfHmacKey, token);
    },
  };
}

export function createSecretServiceFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SecretService {
  return createSecretService({
    sessionHmacKey: environment.SESSION_HMAC_KEY ?? "",
    otpHmacKey: environment.OTP_HMAC_KEY ?? "",
    csrfHmacKey: environment.CSRF_HMAC_KEY ?? "",
  });
}
