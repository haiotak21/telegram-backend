import mongoose from "mongoose";

export async function connectDB(uri?: string) {
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
  try {
    await mongoose.disconnect();
  } catch {}
}
