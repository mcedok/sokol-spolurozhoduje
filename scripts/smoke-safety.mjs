export function assertDisposableSmokeDatabase(databaseUrl, confirmation) {
  const url = new URL(databaseUrl);
  const localHost = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const databaseName = url.pathname.replace(/^\//, "");
  if (!localHost || databaseName !== "sokol_test") {
    throw new Error("Smoke reset is allowed only for local database sokol_test.");
  }
  if (confirmation !== "RESET_LOCAL_SOKOL_TEST") {
    throw new Error("Set SMOKE_ALLOW_DATABASE_RESET=RESET_LOCAL_SOKOL_TEST to permit the destructive smoke reset.");
  }
}

export function assertMatchingDisposableSmokeDatabases(
  hostDatabaseUrl,
  containerDatabaseUrl,
  confirmation,
) {
  assertDisposableSmokeDatabase(hostDatabaseUrl, confirmation);
  const host = new URL(hostDatabaseUrl);
  const container = new URL(containerDatabaseUrl);
  const containerHostAllowed = ["host.docker.internal", "127.0.0.1", "localhost"]
    .includes(container.hostname);
  const sameDatabase = container.pathname === host.pathname
    && container.username === host.username
    && container.password === host.password
    && container.port === host.port;
  if (!containerHostAllowed || !sameDatabase || container.pathname !== "/sokol_test") {
    throw new Error("Container database must match the guarded local sokol_test database.");
  }
}
