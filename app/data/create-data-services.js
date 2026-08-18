export function createDataServices({ env = process.env, browserFactory, serverFactory }) {
  const backend = env.NEXT_PUBLIC_DATA_BACKEND || "server";
  if (backend === "browser") {
    if (env.NODE_ENV === "production") {
      throw new Error("Browser data backend is forbidden in production.");
    }
    return browserFactory();
  }
  if (backend !== "server") throw new Error(`Unknown data backend: ${backend}`);
  return serverFactory();
}
