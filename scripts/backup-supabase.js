/* eslint-disable no-console */
require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { gzip } = require("zlib");
const { promisify } = require("util");
const { PrismaClient } = require("@prisma/client");

const gzipAsync = promisify(gzip);
const prisma = new PrismaClient();

function formatStamp(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function backupTable(name, readFn) {
  const started = Date.now();
  const rows = await readFn();
  const ms = Date.now() - started;
  console.log(`Backed up ${name}: ${rows.length} rows (${ms}ms)`);
  return rows;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  await prisma.$connect();

  const stamp = formatStamp();
  const backupDir = path.resolve(process.cwd(), "backups");
  await fs.mkdir(backupDir, { recursive: true });

  const payload = {
    meta: {
      createdAt: new Date().toISOString(),
      source: "supabase-postgres",
      formatVersion: 1,
    },
    data: {
      users: await backupTable("users", () => prisma.user.findMany({ orderBy: { createdAt: "asc" } })),
      cards: await backupTable("cards", () => prisma.card.findMany({ orderBy: { createdAt: "asc" } })),
      cardRequests: await backupTable("cardRequests", () => prisma.cardRequest.findMany({ orderBy: { createdAt: "asc" } })),
      transactions: await backupTable("transactions", () => prisma.transaction.findMany({ orderBy: { createdAt: "asc" } })),
    },
  };

  const json = Buffer.from(JSON.stringify(payload));
  const gz = await gzipAsync(json, { level: 9 });

  const base = `supabase-backup-${stamp}`;
  const jsonFile = path.join(backupDir, `${base}.json`);
  const gzFile = path.join(backupDir, `${base}.json.gz`);
  const checksumFile = path.join(backupDir, `${base}.sha256.txt`);

  await fs.writeFile(jsonFile, json);
  await fs.writeFile(gzFile, gz);

  const checksumText = [
    `${sha256(json)}  ${path.basename(jsonFile)}`,
    `${sha256(gz)}  ${path.basename(gzFile)}`,
  ].join("\n");
  await fs.writeFile(checksumFile, checksumText + "\n", "utf8");

  console.log("Backup complete:");
  console.log(`- ${jsonFile}`);
  console.log(`- ${gzFile}`);
  console.log(`- ${checksumFile}`);
}

main()
  .catch((err) => {
    console.error("Backup failed:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {}
  });
