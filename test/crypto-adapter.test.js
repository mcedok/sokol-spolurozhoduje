import { describe, expect, it } from "vitest";
import { createCryptoAdapter } from "../app/security/crypto-adapter.js";

describe("crypto adapter", () => {
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
