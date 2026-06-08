import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

export const config = {
  projectRoot,
  port: Number(process.env.PORT || 8787),
  databasePath: process.env.DATABASE_PATH || path.join(projectRoot, "data", "store.sqlite"),
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-before-production",
  adminUser: process.env.ADMIN_USER || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "ChangeMe123!",
  reservationMinutes: Number(process.env.RESERVATION_MINUTES || 15)
};

export function getDatabasePath() {
  return process.env.DATABASE_PATH || config.databasePath;
}
