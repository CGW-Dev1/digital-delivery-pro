import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { customAlphabet } from "nanoid";
import type { AdminStats } from "../shared/types";
import { config } from "./config";
import { getDb, nowIso } from "./db";
import { badRequest, notFound } from "./errors";
import { mapAnnouncement, mapCategory, mapCoupon, mapInventory, mapOrder, mapPaymentMethod, mapProduct } from "./mappers";
import { releaseExpiredReservations } from "./storeService";

const id = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export function login(username: string, password: string) {
  const admin = getDb().prepare("SELECT * FROM admins WHERE username = ?").get(username) as any;
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    throw badRequest("账号或密码错误", "INVALID_CREDENTIALS");
  }
  const token = jwt.sign({ sub: admin.id, username: admin.username, role: admin.role }, config.jwtSecret, { expiresIn: "8h" });
  return { token, user: { id: admin.id, username: admin.username, role: admin.role } };
}

export function verifyToken(token: string) {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string; username?: string; role?: string };
    if (!payload.username || !payload.role) throw new Error("not admin");
    return payload as { sub: string; username: string; role: string };
  } catch {
    throw badRequest("登录状态已失效，请重新登录", "UNAUTHORIZED");
  }
}

export function getDashboard(): AdminStats {
  releaseExpiredReservations();
  const db = getDb();
  const revenue = db.prepare("SELECT COALESCE(SUM(total_cents), 0) AS value FROM orders WHERE status = 'delivered'").get() as any;
  const orders = db.prepare("SELECT COUNT(*) AS value FROM orders").get() as any;
  const delivered = db.prepare("SELECT COUNT(*) AS value FROM orders WHERE status = 'delivered'").get() as any;
  const pending = db.prepare("SELECT COUNT(*) AS value FROM orders WHERE status = 'pending'").get() as any;
  const products = db.prepare("SELECT COUNT(*) AS value FROM products WHERE is_active = 1").get() as any;
  const stock = db.prepare("SELECT COUNT(*) AS value FROM inventory_items WHERE status = 'available'").get() as any;
  return {
    revenueCents: revenue.value,
    orderCount: orders.value,
    deliveredCount: delivered.value,
    pendingCount: pending.value,
    productCount: products.value,
    availableStock: stock.value
  };
}

export function listAdminProducts() {
  releaseExpiredReservations();
  return (getDb().prepare(`
    SELECT
      p.*,
      c.name AS category_name,
      COALESCE(SUM(CASE WHEN i.status = 'available' THEN 1 ELSE 0 END), 0) AS stock,
      COALESCE(SUM(CASE WHEN i.status = 'delivered' THEN 1 ELSE 0 END), 0) AS sold
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory_items i ON i.product_id = p.id
    GROUP BY p.id
    ORDER BY p.sort_order ASC, p.created_at DESC
  `).all() as any[]).map(mapProduct);
}

export function listCategories() {
  return (getDb().prepare("SELECT * FROM categories ORDER BY sort_order ASC, name ASC").all() as any[]).map(mapCategory);
}

export function upsertCategory(input: any) {
  const db = getDb();
  const categoryId = input.id || id();
  const payload = {
    id: categoryId,
    name: String(input.name || "").trim(),
    slug: String(input.slug || "").trim(),
    sortOrder: Number(input.sortOrder || 0),
    isActive: input.isActive === false ? 0 : 1
  };
  if (!payload.name || !payload.slug) throw badRequest("分类名称和标识不能为空");

  const exists = db.prepare("SELECT id FROM categories WHERE id = ?").get(categoryId);
  if (exists) {
    db.prepare(`
      UPDATE categories
      SET name = @name, slug = @slug, sort_order = @sortOrder, is_active = @isActive
      WHERE id = @id
    `).run(payload);
  } else {
    db.prepare(`
      INSERT INTO categories (id, name, slug, sort_order, is_active)
      VALUES (@id, @name, @slug, @sortOrder, @isActive)
    `).run(payload);
  }
  return listCategories().find((category) => category.id === categoryId);
}

export function deleteCategory(categoryId: string) {
  const db = getDb();
  const category = db.prepare("SELECT id FROM categories WHERE id = ?").get(categoryId);
  if (!category) throw notFound("分类不存在");
  const linkedProducts = db.prepare("SELECT COUNT(*) AS count FROM products WHERE category_id = ?").get(categoryId) as any;
  if (linkedProducts.count > 0) throw badRequest("该分类下还有商品，请先删除或移动商品");
  db.prepare("DELETE FROM categories WHERE id = ?").run(categoryId);
  return { ok: true };
}

export function upsertProduct(input: any) {
  const db = getDb();
  const now = nowIso();
  const productId = input.id || id();
  const payload = {
    id: productId,
    categoryId: input.categoryId,
    name: input.name,
    slug: input.slug,
    subtitle: input.subtitle || "",
    description: input.description || "",
    priceCents: Math.round(Number(input.priceCents)),
    marketPriceCents: Math.round(Number(input.marketPriceCents || 0)),
    coverUrl: input.coverUrl || "",
    tagsJson: JSON.stringify(input.tags || []),
    buyLimit: Math.max(1, Number(input.buyLimit || 1)),
    requireContact: input.requireContact === false ? 0 : 1,
    isActive: input.isActive === false ? 0 : 1,
    sortOrder: Number(input.sortOrder || 0),
    now
  };

  if (!payload.categoryId || !payload.name || !payload.slug || payload.priceCents < 0) {
    throw badRequest("商品分类、名称、链接和价格不能为空");
  }

  const exists = db.prepare("SELECT id FROM products WHERE id = ?").get(productId);
  if (exists) {
    db.prepare(`
      UPDATE products SET
        category_id = @categoryId,
        name = @name,
        slug = @slug,
        subtitle = @subtitle,
        description = @description,
        price_cents = @priceCents,
        market_price_cents = @marketPriceCents,
        cover_url = @coverUrl,
        tags_json = @tagsJson,
        buy_limit = @buyLimit,
        require_contact = @requireContact,
        is_active = @isActive,
        sort_order = @sortOrder,
        updated_at = @now
      WHERE id = @id
    `).run(payload);
  } else {
    db.prepare(`
      INSERT INTO products (
        id, category_id, name, slug, subtitle, description, price_cents,
        market_price_cents, cover_url, tags_json, delivery_type, buy_limit,
        require_contact, is_active, sort_order, created_at, updated_at
      ) VALUES (
        @id, @categoryId, @name, @slug, @subtitle, @description, @priceCents,
        @marketPriceCents, @coverUrl, @tagsJson, 'card', @buyLimit,
        @requireContact, @isActive, @sortOrder, @now, @now
      )
    `).run(payload);
  }
  return listAdminProducts().find((product) => product.id === productId);
}

export function deleteProduct(productId: string) {
  const db = getDb();
  const product = db.prepare("SELECT id FROM products WHERE id = ?").get(productId);
  if (!product) throw notFound("商品不存在");
  const linkedOrders = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE product_id = ?").get(productId) as any;
  if (linkedOrders.count > 0) throw badRequest("该商品已有订单记录，不能直接删除，可先下架商品");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM inventory_items WHERE product_id = ?").run(productId);
    db.prepare("DELETE FROM products WHERE id = ?").run(productId);
  });
  tx();
  return { ok: true };
}

export function addInventory(productId: string, lines: string[]) {
  const db = getDb();
  const product = db.prepare("SELECT id FROM products WHERE id = ?").get(productId);
  if (!product) throw notFound("商品不存在");
  const cleanLines = lines.map((line) => line.trim()).filter(Boolean);
  if (cleanLines.length === 0) throw badRequest("请输入至少一条卡密");
  const createdAt = nowIso();
  const tx = db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO inventory_items (id, product_id, secret, status, created_at)
      VALUES (?, ?, ?, 'available', ?)
    `);
    cleanLines.forEach((line) => insert.run(id(), productId, line, createdAt));
  });
  tx();
  return { added: cleanLines.length };
}

export function listInventory(productId?: string) {
  releaseExpiredReservations();
  const params: string[] = [];
  let where = "";
  if (productId) {
    where = "WHERE i.product_id = ?";
    params.push(productId);
  }
  return (getDb().prepare(`
    SELECT i.*, p.name AS product_name
    FROM inventory_items i
    JOIN products p ON p.id = i.product_id
    ${where}
    ORDER BY i.created_at DESC
    LIMIT 300
  `).all(...params) as any[]).map(mapInventory);
}

export function deleteInventoryItem(itemId: string) {
  const db = getDb();
  const item = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(itemId) as any;
  if (!item) throw notFound("库存卡密不存在");
  if (!["available", "disabled"].includes(item.status)) {
    throw badRequest("该卡密已被锁定或发货，不能删除");
  }
  db.prepare("DELETE FROM inventory_items WHERE id = ?").run(itemId);
  return { ok: true };
}

export function listOrders() {
  releaseExpiredReservations();
  return (getDb().prepare(`
    SELECT o.*, p.name AS product_name, p.slug AS product_slug
    FROM orders o
    JOIN products p ON p.id = o.product_id
    ORDER BY o.created_at DESC
    LIMIT 300
  `).all() as any[]).map(mapOrder);
}

export function updateOrderStatus(orderId: string, status: string) {
  if (!["closed", "refunded", "delivered"].includes(status)) {
    throw badRequest("不支持的订单状态");
  }
  const db = getDb();
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as any;
  if (!order) throw notFound("订单不存在");
  if (status === "closed" && order.status === "pending") {
    db.prepare(`
      UPDATE inventory_items
      SET status = 'available', order_id = NULL, reserved_until = NULL
      WHERE order_id = ? AND status = 'reserved'
    `).run(orderId);
  }
  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, orderId);
  return listOrders().find((item) => item.id === orderId);
}

export function deleteOrder(orderId: string) {
  const db = getDb();
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as any;
  if (!order) throw notFound("订单不存在");
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE inventory_items
      SET status = 'available', order_id = NULL, reserved_until = NULL
      WHERE order_id = ? AND status = 'reserved'
    `).run(orderId);
    db.prepare(`
      UPDATE inventory_items
      SET order_id = NULL, reserved_until = NULL
      WHERE order_id = ? AND status != 'reserved'
    `).run(orderId);
    db.prepare("DELETE FROM orders WHERE id = ?").run(orderId);
  });
  tx();
  return { ok: true };
}

export function listCoupons() {
  return (getDb().prepare("SELECT * FROM coupons ORDER BY code ASC").all() as any[]).map(mapCoupon);
}

export function listPaymentMethods() {
  return (getDb().prepare(`
    SELECT * FROM payment_methods
    ORDER BY sort_order ASC, name ASC
  `).all() as any[]).map(mapPaymentMethod);
}

export function upsertPaymentMethod(input: any) {
  const db = getDb();
  const methodId = input.id || id();
  const payload = {
    id: methodId,
    code: String(input.code || "").trim().toLowerCase(),
    name: String(input.name || "").trim(),
    icon: String(input.icon || "credit-card").trim(),
    description: String(input.description || "").trim(),
    sortOrder: Number(input.sortOrder || 0),
    isActive: input.isActive === false ? 0 : 1
  };
  if (!payload.code || !payload.name) throw badRequest("支付代码和名称不能为空");

  const exists = db.prepare("SELECT id FROM payment_methods WHERE id = ?").get(methodId);
  if (exists) {
    db.prepare(`
      UPDATE payment_methods
      SET code = @code, name = @name, icon = @icon, description = @description,
        sort_order = @sortOrder, is_active = @isActive
      WHERE id = @id
    `).run(payload);
  } else {
    db.prepare(`
      INSERT INTO payment_methods (id, code, name, icon, description, sort_order, is_active)
      VALUES (@id, @code, @name, @icon, @description, @sortOrder, @isActive)
    `).run(payload);
  }
  return listPaymentMethods().find((method) => method.id === methodId);
}

export function deletePaymentMethod(methodId: string) {
  const db = getDb();
  const method = db.prepare("SELECT * FROM payment_methods WHERE id = ?").get(methodId) as any;
  if (!method) throw notFound("支付方式不存在");
  const activeCount = db.prepare("SELECT COUNT(*) AS count FROM payment_methods WHERE is_active = 1").get() as any;
  if (method.is_active && activeCount.count <= 1) throw badRequest("至少需要保留一个启用的支付方式");
  db.prepare("DELETE FROM payment_methods WHERE id = ?").run(methodId);
  return { ok: true };
}

export function upsertCoupon(input: any) {
  const db = getDb();
  const couponId = input.id || id();
  const payload = {
    id: couponId,
    code: String(input.code || "").trim().toUpperCase(),
    type: input.type === "percent" ? "percent" : "fixed",
    value: Math.max(0, Number(input.value || 0)),
    minAmountCents: Math.max(0, Number(input.minAmountCents || 0)),
    totalLimit: Math.max(0, Number(input.totalLimit || 0)),
    startsAt: input.startsAt || null,
    endsAt: input.endsAt || null,
    isActive: input.isActive === false ? 0 : 1
  };
  if (!payload.code || payload.value <= 0) throw badRequest("优惠码和值不能为空");

  const exists = db.prepare("SELECT id FROM coupons WHERE id = ?").get(couponId);
  if (exists) {
    db.prepare(`
      UPDATE coupons SET code = @code, type = @type, value = @value,
        min_amount_cents = @minAmountCents, total_limit = @totalLimit,
        starts_at = @startsAt, ends_at = @endsAt, is_active = @isActive
      WHERE id = @id
    `).run(payload);
  } else {
    db.prepare(`
      INSERT INTO coupons (id, code, type, value, min_amount_cents, total_limit, used_count, starts_at, ends_at, is_active)
      VALUES (@id, @code, @type, @value, @minAmountCents, @totalLimit, 0, @startsAt, @endsAt, @isActive)
    `).run(payload);
  }
  return listCoupons().find((coupon) => coupon.id === couponId);
}

export function deleteCoupon(couponId: string) {
  const db = getDb();
  const coupon = db.prepare("SELECT id FROM coupons WHERE id = ?").get(couponId);
  if (!coupon) throw notFound("优惠券不存在");
  db.prepare("DELETE FROM coupons WHERE id = ?").run(couponId);
  return { ok: true };
}

export function listAnnouncements() {
  return (getDb().prepare("SELECT * FROM announcements ORDER BY created_at DESC").all() as any[]).map(mapAnnouncement);
}

export function upsertAnnouncement(input: any) {
  const db = getDb();
  const announcementId = input.id || id();
  const payload = {
    id: announcementId,
    title: String(input.title || "").trim(),
    content: String(input.content || "").trim(),
    level: ["info", "success", "warning"].includes(input.level) ? input.level : "info",
    isActive: input.isActive === false ? 0 : 1,
    now: nowIso()
  };
  if (!payload.title || !payload.content) throw badRequest("公告标题和内容不能为空");

  const exists = db.prepare("SELECT id FROM announcements WHERE id = ?").get(announcementId);
  if (exists) {
    db.prepare(`
      UPDATE announcements
      SET title = @title, content = @content, level = @level, is_active = @isActive
      WHERE id = @id
    `).run(payload);
  } else {
    db.prepare(`
      INSERT INTO announcements (id, title, content, level, is_active, created_at)
      VALUES (@id, @title, @content, @level, @isActive, @now)
    `).run(payload);
  }
  return listAnnouncements().find((announcement) => announcement.id === announcementId);
}

export function deleteAnnouncement(announcementId: string) {
  const db = getDb();
  const announcement = db.prepare("SELECT id FROM announcements WHERE id = ?").get(announcementId);
  if (!announcement) throw notFound("公告不存在");
  db.prepare("DELETE FROM announcements WHERE id = ?").run(announcementId);
  return { ok: true };
}

export function getSettings() {
  const rows = getDb().prepare("SELECT key, value FROM settings ORDER BY key ASC").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function updateSettings(settings: Record<string, string>) {
  const db = getDb();
  const allowed = ["store_name", "store_slogan", "support_email", "payment_notice", "checkout_tips", "support_hours", "stock_warning", "store_theme"];
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  allowed.forEach((key) => {
    if (settings[key] !== undefined) stmt.run(key, String(settings[key]));
  });
  return getSettings();
}
