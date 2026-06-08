import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { customAlphabet } from "nanoid";
import type { Customer } from "../shared/types";
import { config } from "./config";
import { getDb, nowIso } from "./db";
import { badRequest, notFound } from "./errors";
import { mapOrder } from "./mappers";
import { redactOrderSecrets, revealOrderSecrets } from "./security";
import { releaseExpiredReservations } from "./storeService";

const id = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function mapCustomer(row: any): Customer {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at
  };
}

function issueToken(customer: Customer) {
  return jwt.sign(
    { sub: customer.id, email: customer.email, name: customer.name, kind: "customer" },
    config.jwtSecret,
    { expiresIn: "30d" }
  );
}

export async function registerCustomer(input: { email: string; password: string; name?: string }) {
  const db = await getDb();
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) throw badRequest("请输入有效邮箱");
  if (input.password.length < 6) throw badRequest("密码至少 6 位");

  const exists = await db.get("SELECT id FROM customers WHERE email = ?", [email]);
  if (exists) throw badRequest("该邮箱已注册");

  const customerId = id();
  const createdAt = nowIso();
  await db.run(`
    INSERT INTO customers (id, email, name, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `, [customerId, email, input.name?.trim() || email.split("@")[0], bcrypt.hashSync(input.password, 12), createdAt]);

  const customer = mapCustomer(await db.get("SELECT * FROM customers WHERE id = ?", [customerId]));
  return { token: issueToken(customer), user: customer };
}

export async function loginCustomer(input: { email: string; password: string }) {
  const email = normalizeEmail(input.email);
  const row = await (await getDb()).get<any>("SELECT * FROM customers WHERE email = ?", [email]);
  if (!row || !bcrypt.compareSync(input.password, row.password_hash)) {
    throw badRequest("邮箱或密码错误", "INVALID_CREDENTIALS");
  }
  const customer = mapCustomer(row);
  return { token: issueToken(customer), user: customer };
}

export function verifyCustomerToken(token: string) {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string; email: string; name: string; kind?: string };
    if (payload.kind !== "customer") throw new Error("not customer");
    return payload;
  } catch {
    throw badRequest("登录状态已失效，请重新登录", "UNAUTHORIZED");
  }
}

export async function getCustomerById(customerId: string) {
  const row = await (await getDb()).get("SELECT * FROM customers WHERE id = ?", [customerId]);
  if (!row) throw notFound("用户不存在");
  return mapCustomer(row);
}

export async function listCustomerOrders(customerId: string) {
  await releaseExpiredReservations();
  return (await (await getDb()).all(`
    SELECT o.*, p.name AS product_name, p.slug AS product_slug
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.user_id = ?
    ORDER BY o.created_at DESC
    LIMIT 100
  `, [customerId])).map(mapOrder).map(revealOrderSecrets);
}

export async function listGuestOrdersByContact(contact: string) {
  await releaseExpiredReservations();
  const clean = contact.trim();
  if (clean.length < 3) throw badRequest("请输入下单联系方式");
  return (await (await getDb()).all(`
    SELECT o.*, p.name AS product_name, p.slug AS product_slug
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.contact = ?
    ORDER BY o.created_at DESC
    LIMIT 50
  `, [clean])).map(mapOrder).map((order) => redactOrderSecrets(order, true));
}
