"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = connectDB;
exports.disconnectDB = disconnectDB;
const mongoose_1 = __importDefault(require("mongoose"));
const prisma_1 = __importDefault(require("./utils/prisma"));
const persistence_1 = require("./utils/persistence");
async function connectDB(uri) {
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
            console.warn("DATABASE_URL not set; running without persistence");
            return;
        }
        try {
            await prisma_1.default.$connect();
            await prisma_1.default.$queryRaw `SELECT 1`;
            console.log("PostgreSQL connected via Prisma");
        }
        catch (err) {
            console.error("PostgreSQL connection failed. Check DATABASE_URL.");
            throw err;
        }
        const allowMongoFallback = String(process.env.ENABLE_MONGO_FALLBACK || "false").toLowerCase() === "true";
        const mongoUriInPrismaMode = uri || process.env.MONGODB_URI;
        if (allowMongoFallback && mongoUriInPrismaMode) {
            try {
                await mongoose_1.default.connect(mongoUriInPrismaMode, {});
                const { host, port, name } = mongoose_1.default.connection;
                console.log(`MongoDB connected for fallback (${host ?? "cluster"}${port ? ":" + port : ""}) db="${name}"`);
            }
            catch (err) {
                console.warn("MongoDB fallback connection failed; only Prisma-backed routes will work.");
            }
        }
        else if (mongoUriInPrismaMode && !allowMongoFallback) {
            console.log("Prisma mode active; Mongo fallback disabled (set ENABLE_MONGO_FALLBACK=true to enable).\nIf legacy data is missing, run migrate:mongo-to-supabase from an accessible Mongo source.");
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
    const options = {};
    if (dbName)
        options.dbName = dbName;
    if (authSource)
        options.authSource = authSource;
    try {
        await mongoose_1.default.connect(mongoUri, options);
        const { host, port, name } = mongoose_1.default.connection;
        console.log(`MongoDB connected (${host ?? "cluster"}${port ? ":" + port : ""}) db="${name}"`);
    }
    catch (err) {
        console.error("MongoDB connection failed. Check credentials/URI.");
        throw err;
    }
    const conn = mongoose_1.default.connection;
    conn.on("error", (err) => {
        console.error("MongoDB error:", err);
    });
}
async function disconnectDB() {
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        try {
            await prisma_1.default.$disconnect();
        }
        catch { }
        try {
            await mongoose_1.default.disconnect();
        }
        catch { }
        return;
    }
    try {
        await mongoose_1.default.disconnect();
    }
    catch { }
}
