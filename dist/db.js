"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = connectDB;
exports.disconnectDB = disconnectDB;
const mongoose_1 = __importDefault(require("mongoose"));
async function connectDB(uri) {
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
    try {
        await mongoose_1.default.disconnect();
    }
    catch { }
}
