export function isPrismaPersistenceEnabled() {
  const flag = String(process.env.USE_PRISMA_PERSISTENCE || "").toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
  if (!hasDatabaseUrl) return false;
  if (process.env.NODE_ENV === "test") {
    return String(process.env.USE_PRISMA_PERSISTENCE_IN_TESTS || "").toLowerCase() === "true";
  }
  return true;
}
