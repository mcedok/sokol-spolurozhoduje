import { z } from "zod";

const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
});

export function databaseConfig(env: NodeJS.ProcessEnv = process.env): {
  databaseUrl: string;
} {
  const parsed = databaseEnvironmentSchema.parse({
    DATABASE_URL: env.DATABASE_URL,
  });
  return { databaseUrl: parsed.DATABASE_URL };
}
