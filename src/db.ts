import mongoose from "mongoose";
import prisma from "./utils/prisma";
import { isPrismaPersistenceEnabled } from "./utils/persistence";

export async function connectDB(uri?: string) {
  if (isPrismaPersistenceEnabled()) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.warn("DATABASE_URL not set; running without persistence");
      return;
    }
    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      console.log("PostgreSQL connected via Prisma");
    } catch (err) {
      console.error("PostgreSQL connection failed. Check DATABASE_URL.");
      throw err;
    }

    const mongoUriInPrismaMode = uri || process.env.MONGODB_URI;
    if (mongoUriInPrismaMode) {
      try {
        await mongoose.connect(mongoUriInPrismaMode, {});
        const { host, port, name } = mongoose.connection;
        console.log(
          `MongoDB connected for fallback (${host ?? "cluster"}${port ? ":" + port : ""}) db="${name}"`
        );
      } catch (err) {
        console.warn("MongoDB fallback connection failed; only Prisma-backed routes will work.");
      }
    }
    return;
  }

  const mongoUri = uri || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.warn("MONGODB_URI not set; running without persistence");
    return;
  }

  const dbName = process.env.MONGODB_DB_NAME;
  const authSource = process.env.MONGODB_AUTHSOURCE;

  const options: mongoose.ConnectOptions = {};
  if (dbName) options.dbName = dbName;
  if (authSource) (options as any).authSource = authSource;

  try {
    await mongoose.connect(mongoUri, options);
    const { host, port, name } = mongoose.connection;
    console.log(
      `MongoDB connected (${host ?? "cluster"}${port ? ":" + port : ""}) db="${name}"`
    );
  } catch (err) {
    console.error("MongoDB connection failed. Check credentials/URI.");
    throw err;
  }

  const conn = mongoose.connection;
  conn.on("error", (err) => {
    console.error("MongoDB error:", err);
  });
}

export async function disconnectDB() {
  if (isPrismaPersistenceEnabled()) {
    try {
      await prisma.$disconnect();
    } catch {}
    try {
      await mongoose.disconnect();
    } catch {}
    return;
  }
  try {
    await mongoose.disconnect();
  } catch {}
}
