import { describe, expect, it } from "vitest";
import { createCryptoAdapter } from "../app/security/crypto-adapter.js";

describe("crypto adapter", () => {
  it("derives a 256-bit PBKDF2 SHA-256 hash with 210000 iterations and a 16-byte salt", async () => {
    const calls = {};
    const crypto = {
      getRandomValues(bytes) {
        bytes.fill(7);
        return bytes;
      },
      subtle: {
        async importKey(...args) {
          calls.importKey = args;
          return "derived-key";
        },
        async deriveBits(parameters, key, length) {
          calls.deriveBits = { parameters, key, length };
          return new Uint8Array(32).buffer;
        },
      },
    };
    const adapter = createCryptoAdapter(crypto);

    const credential = await adapter.hashSecret("SuperSokol!2026");

    expect(Buffer.from(credential.salt, "base64")).toHaveLength(16);
    expect(calls.importKey.slice(2)).toEqual(["PBKDF2", false, ["deriveBits"]]);
    expect(calls.deriveBits).toMatchObject({
      parameters: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: 210000,
        salt: expect.any(Uint8Array),
      },
      key: "derived-key",
      length: 256,
    });
    expect(calls.deriveBits.parameters.salt).toHaveLength(16);
  });

  it("verifies the same secret and rejects a different one", async () => {
    const adapter = createCryptoAdapter(globalThis.crypto);

    const credential = await adapter.hashSecret("SuperSokol!2026");

    await expect(
      adapter.verifySecret("SuperSokol!2026", credential.salt, credential.hash),
    ).resolves.toBe(true);
    await expect(
      adapter.verifySecret("WrongSokol!2026", credential.salt, credential.hash),
    ).resolves.toBe(false);
  });

  it("creates a six-digit member code", () => {
    const adapter = createCryptoAdapter(globalThis.crypto);

    expect(adapter.randomDigits(6)).toMatch(/^\d{6}$/);
  });

  it("creates a token containing at least 32 random bytes before encoding", () => {
    const adapter = createCryptoAdapter(globalThis.crypto);

    const token = adapter.randomToken();

    expect(Buffer.from(token, "base64url").byteLength).toBeGreaterThanOrEqual(32);
  });
});
