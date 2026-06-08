import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

export const config = {
  projectRoot,
  port: Number(process.env.PORT || 8787),
  databaseClient: (process.env.DATABASE_CLIENT || (process.env.MYSQL_URL || process.env.MYSQL_HOST ? "mysql" : "sqlite")).toLowerCase(),
  databasePath: process.env.DATABASE_PATH || path.join(projectRoot, "data", "store.sqlite"),
  mysql: {
    uri: process.env.MYSQL_URL || "",
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "digital_delivery_pro",
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10)
  },
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-before-production",
  allowMockPayment: process.env.ENABLE_MOCK_PAYMENT === "true" || process.env.NODE_ENV !== "production",
  corsOrigins: (process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  adminUser: process.env.ADMIN_USER || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "ChangeMe123!",
  reservationMinutes: Number(process.env.RESERVATION_MINUTES || 15)
};

export function getDatabasePath() {
  return process.env.DATABASE_PATH || config.databasePath;
}
