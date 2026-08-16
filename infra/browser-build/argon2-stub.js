export const Algorithm = { Argon2id: 2 };

export async function hash() {
  throw new Error("Server password hashing is unavailable in the browser demo build.");
}

export async function verify() {
  throw new Error("Server password verification is unavailable in the browser demo build.");
}
