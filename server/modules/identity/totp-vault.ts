import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generateSecret, generateSync, generateURI, verifySync } from "otplib";

export interface TotpVault {
  newSecret(): string;
  encrypt(secret: string): Buffer;
  decrypt(ciphertext: Uint8Array): string;
  uri(label: string, secret: string): string;
  generate(secret: string): string;
  verify(secret: string, token: string): boolean;
}

export function createTotpVault(config: { encryptionKey: string }): TotpVault {
  const key = Buffer.from(config.encryptionKey, "utf8");
  if (key.length !== 32) throw new Error("TOTP_ENCRYPTION_KEY must contain exactly 32 bytes");

  return {
    newSecret: () => generateSecret(),
    encrypt(secret) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decrypt(ciphertext) {
      const value = Buffer.from(ciphertext);
      if (value.length < 29) throw new Error("Invalid encrypted TOTP secret");
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
    uri(label, secret) {
      return generateURI({ issuer: "Sokol spolu rozhoduje", label, secret });
    },
    generate(secret) {
      return generateSync({ secret });
    },
    verify(secret, token) {
      return verifySync({ secret, token, epochTolerance: 30 }).valid;
    },
  };
}

export function createTotpVaultFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): TotpVault {
  return createTotpVault({ encryptionKey: environment.TOTP_ENCRYPTION_KEY ?? "" });
}
