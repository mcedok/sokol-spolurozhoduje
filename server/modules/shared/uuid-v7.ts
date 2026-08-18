import { randomBytes } from "node:crypto";

export function uuidV7(timestamp = Date.now(), random = randomBytes(10)): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new Error("Čas UUIDv7 je mimo povolený rozsah.");
  }
  if (random.length < 10) throw new Error("UUIDv7 vyžaduje 10 náhodných bajtů.");
  const bytes = Buffer.alloc(16);
  let remaining = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  bytes[6] = 0x70 | (random[0] & 0x0f);
  bytes[7] = random[1];
  bytes[8] = 0x80 | (random[2] & 0x3f);
  random.copy(bytes, 9, 3, 10);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
