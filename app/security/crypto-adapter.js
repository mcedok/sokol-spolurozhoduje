const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const HASH_BITS = 256;
const PBKDF2_ITERATIONS = 210_000;

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function createCryptoAdapter(crypto) {
  if (!crypto?.getRandomValues || !crypto?.subtle) {
    throw new TypeError("Web Crypto API is required.");
  }

  function randomDigits(length) {
    let digits = "";
    while (digits.length < length) {
      const random = new Uint8Array(length - digits.length);
      crypto.getRandomValues(random);
      for (const value of random) {
        if (value < 250) digits += String(value % 10);
      }
    }
    return digits;
  }

  function randomToken() {
    const random = new Uint8Array(TOKEN_BYTES);
    crypto.getRandomValues(random);
    return bytesToBase64Url(random);
  }

  async function hashSecret(secret, salt) {
    const saltBytes = salt ? base64ToBytes(salt) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derived = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: saltBytes,
          iterations: PBKDF2_ITERATIONS,
        },
        key,
        HASH_BITS,
      ),
    );

    return { salt: bytesToBase64(saltBytes), hash: bytesToBase64(derived) };
  }

  async function verifySecret(secret, salt, expectedHash) {
    try {
      const { hash } = await hashSecret(secret, salt);
      const actualBytes = base64ToBytes(hash);
      const expectedBytes = base64ToBytes(expectedHash);
      const length = Math.max(actualBytes.length, expectedBytes.length);
      let difference = actualBytes.length ^ expectedBytes.length;

      for (let index = 0; index < length; index += 1) {
        difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
      }

      return difference === 0;
    } catch {
      return false;
    }
  }

  return { randomDigits, randomToken, hashSecret, verifySecret };
}
