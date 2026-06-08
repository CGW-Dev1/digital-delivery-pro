import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DeliveredItem, InventoryItem, Order } from "../shared/types";
import { config } from "./config";

const SECRET_PREFIX = "enc:v1:";

export function isEncryptedSecret(secret: string) {
  return secret.startsWith(SECRET_PREFIX);
}

function resolveKey() {
  const configured = process.env.DELIVERY_SECRET_KEY || process.env.CARD_SECRET_KEY || "";
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("DELIVERY_SECRET_KEY is required in production");
  }

  const material = configured || config.jwtSecret || "digital-delivery-pro-dev-secret";
  if (/^[a-f0-9]{64}$/i.test(material)) return Buffer.from(material, "hex");

  try {
    const decoded = Buffer.from(material, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall back to hashing below.
  }

  return createHash("sha256").update(material).digest();
}

export function encryptSecret(secret: string) {
  if (isEncryptedSecret(secret)) return secret;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", resolveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(secret: string) {
  if (!isEncryptedSecret(secret)) return secret;
  const encoded = secret.slice(SECRET_PREFIX.length);
  const [ivPart, tagPart, encryptedPart] = encoded.split(".");
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error("Invalid encrypted delivery secret");
  }

  const decipher = createDecipheriv("aes-256-gcm", resolveKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function maskSecret(secret: string) {
  const plain = decryptSecret(secret).trim();
  if (!plain) return "";
  if (plain.length <= 8) return "****";
  return `${plain.slice(0, 4)}****${plain.slice(-4)}`;
}

export function revealDeliveredPayload(items: DeliveredItem[]) {
  return items.map((item) => ({ ...item, secret: decryptSecret(item.secret) }));
}

export function maskDeliveredPayload(items: DeliveredItem[]) {
  return items.map((item) => ({ ...item, secret: maskSecret(item.secret) }));
}

export function revealOrderSecrets(order: Order) {
  if (order.status !== "delivered") return { ...order, deliveredPayload: [] };
  return { ...order, deliveredPayload: revealDeliveredPayload(order.deliveredPayload) };
}

export function redactOrderSecrets(order: Order, keepCount = false) {
  if (!keepCount || order.status !== "delivered") return { ...order, deliveredPayload: [] };
  return { ...order, deliveredPayload: maskDeliveredPayload(order.deliveredPayload) };
}

export function redactInventorySecret(item: InventoryItem) {
  return { ...item, secret: maskSecret(item.secret) };
}

export function createPaymentToken() {
  return randomBytes(32).toString("base64url");
}

export function hashPaymentToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyPaymentToken(token: string | undefined, expectedHash: string | null | undefined) {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(hashPaymentToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
