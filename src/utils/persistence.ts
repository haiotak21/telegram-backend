export function isPrismaPersistenceEnabled() {
  const enabled = String(process.env.USE_PRISMA_PERSISTENCE || "").toLowerCase() === "true";
  if (!enabled) return false;
  if (process.env.NODE_ENV === "test") {
    return String(process.env.USE_PRISMA_PERSISTENCE_IN_TESTS || "").toLowerCase() === "true";
  }
  return true;
}
