import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { customAlphabet } from "nanoid";
import type { AdminStats } from "../shared/types";
import { config } from "./config";
import { type DbClient, getDb, nowIso } from "./db";
import { badRequest, notFound } from "./errors";
import { mapAnnouncement, mapCategory, mapCoupon, mapInventory, mapOrder, mapPaymentMethod, mapProduct } from "./mappers";
import { encryptSecret, redactInventorySecret, redactOrderSecrets, revealDeliveredPayload } from "./security";
import { releaseExpiredReservations } from "./storeService";

const id = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

const productStockJoin = `
  LEFT JOIN (
    SELECT
      product_id,
      COALESCE(SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END), 0) AS stock,
      COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS sold
    FROM inventory_items
    GROUP BY product_id
  ) inv ON inv.product_id = p.id
`;

export async function login(username: string, password: string) {
  const admin = await (await getDb()).get<any>("SELECT * FROM admins WHERE username = ?", [username]);
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

export async function getDashboard(): Promise<AdminStats> {
  await releaseExpiredReservations();
  const db = await getDb();
  const revenue = await db.get<any>("SELECT COALESCE(SUM(total_cents), 0) AS value FROM orders WHERE status = 'delivered'");
  const orders = await db.get<any>("SELECT COUNT(*) AS value FROM orders");
  const delivered = await db.get<any>("SELECT COUNT(*) AS value FROM orders WHERE status = 'delivered'");
  const pending = await db.get<any>("SELECT COUNT(*) AS value FROM orders WHERE status = 'pending'");
  const products = await db.get<any>("SELECT COUNT(*) AS value FROM products WHERE is_active = 1");
  const stock = await db.get<any>("SELECT COUNT(*) AS value FROM inventory_items WHERE status = 'available'");
  return {
    revenueCents: Number(revenue?.value || 0),
    orderCount: Number(orders?.value || 0),
    deliveredCount: Number(delivered?.value || 0),
    pendingCount: Number(pending?.value || 0),
    productCount: Number(products?.value || 0),
    availableStock: Number(stock?.value || 0)
  };
}

export async function listAdminProducts() {
  await releaseExpiredReservations();
  return (await (await getDb()).all(`
    SELECT
      p.*,
      c.name AS category_name,
      COALESCE(inv.stock, 0) AS stock,
      COALESCE(inv.sold, 0) AS sold
    FROM products p
    JOIN categories c ON c.id = p.category_id
    ${productStockJoin}
    ORDER BY p.sort_order ASC, p.created_at DESC
  `)).map(mapProduct);
}

export async function listCategories() {
  return (await (await getDb()).all("SELECT * FROM categories ORDER BY sort_order ASC, name ASC")).map(mapCategory);
}

export async function upsertCategory(input: any) {
  const db = await getDb();
  const categoryId = input.id || id();
  const payload = {
    id: categoryId,
    name: String(input.name || "").trim(),
    slug: String(input.slug || "").trim(),
    sortOrder: Number(input.sortOrder || 0),
    isActive: input.isActive === false ? 0 : 1
  };
  if (!payload.name || !payload.slug) throw badRequest("分类名称和标识不能为空");

  const exists = await db.get("SELECT id FROM categories WHERE id = ?", [categoryId]);
  if (exists) {
    await db.run(`
      UPDATE categories
      SET name = ?, slug = ?, sort_order = ?, is_active = ?
      WHERE id = ?
    `, [payload.name, payload.slug, payload.sortOrder, payload.isActive, payload.id]);
  } else {
    await db.run(`
      INSERT INTO categories (id, name, slug, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?)
    `, [payload.id, payload.name, payload.slug, payload.sortOrder, payload.isActive]);
  }
  return (await listCategories()).find((category) => category.id === categoryId);
}

export async function deleteCategory(categoryId: string) {
  const db = await getDb();
  const category = await db.get("SELECT id FROM categories WHERE id = ?", [categoryId]);
  if (!category) throw notFound("分类不存在");
  const linkedProducts = await db.get<any>("SELECT COUNT(*) AS count FROM products WHERE category_id = ?", [categoryId]);
  if (Number(linkedProducts?.count || 0) > 0) throw badRequest("该分类下还有商品，请先删除或移动商品");
  await db.run("DELETE FROM categories WHERE id = ?", [categoryId]);
  return { ok: true };
}

export async function upsertProduct(input: any) {
  const db = await getDb();
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

  if (!payload.categoryId || !payload.name || !payload.slug || payload.priceCents <= 0) {
    throw badRequest("商品分类、名称、链接和价格不能为空");
  }

  const exists = await db.get("SELECT id FROM products WHERE id = ?", [productId]);
  if (exists) {
    await db.run(`
      UPDATE products SET
        category_id = ?,
        name = ?,
        slug = ?,
        subtitle = ?,
        description = ?,
        price_cents = ?,
        market_price_cents = ?,
        cover_url = ?,
        tags_json = ?,
        buy_limit = ?,
        require_contact = ?,
        is_active = ?,
        sort_order = ?,
        updated_at = ?
      WHERE id = ?
    `, [
      payload.categoryId,
      payload.name,
      payload.slug,
      payload.subtitle,
      payload.description,
      payload.priceCents,
      payload.marketPriceCents,
      payload.coverUrl,
      payload.tagsJson,
      payload.buyLimit,
      payload.requireContact,
      payload.isActive,
      payload.sortOrder,
      payload.now,
      payload.id
    ]);
  } else {
    await db.run(`
      INSERT INTO products (
        id, category_id, name, slug, subtitle, description, price_cents,
        market_price_cents, cover_url, tags_json, delivery_type, buy_limit,
        require_contact, is_active, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'card', ?, ?, ?, ?, ?, ?)
    `, [
      payload.id,
      payload.categoryId,
      payload.name,
      payload.slug,
      payload.subtitle,
      payload.description,
      payload.priceCents,
      payload.marketPriceCents,
      payload.coverUrl,
      payload.tagsJson,
      payload.buyLimit,
      payload.requireContact,
      payload.isActive,
      payload.sortOrder,
      payload.now,
      payload.now
    ]);
  }
  return (await listAdminProducts()).find((product) => product.id === productId);
}

export async function deleteProduct(productId: string) {
  const db = await getDb();
  const product = await db.get("SELECT id FROM products WHERE id = ?", [productId]);
  if (!product) throw notFound("商品不存在");
  const linkedOrders = await db.get<any>("SELECT COUNT(*) AS count FROM orders WHERE product_id = ?", [productId]);
  if (Number(linkedOrders?.count || 0) > 0) throw badRequest("该商品已有订单记录，不能直接删除，可先下架商品");
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM inventory_items WHERE product_id = ?", [productId]);
    await tx.run("DELETE FROM products WHERE id = ?", [productId]);
  });
  return { ok: true };
}

export async function addInventory(productId: string, lines: string[]) {
  const db = await getDb();
  const product = await db.get("SELECT id FROM products WHERE id = ?", [productId]);
  if (!product) throw notFound("商品不存在");
  const cleanLines = lines.map((line) => line.trim()).filter(Boolean);
  if (cleanLines.length === 0) throw badRequest("请输入至少一条卡密");
  const createdAt = nowIso();
  await db.transaction(async (tx) => {
    for (const line of cleanLines) {
      await tx.run(`
        INSERT INTO inventory_items (id, product_id, secret, status, created_at)
        VALUES (?, ?, ?, 'available', ?)
      `, [id(), productId, encryptSecret(line), createdAt]);
    }
  });
  return { added: cleanLines.length };
}

export async function listInventory(productId?: string) {
  await releaseExpiredReservations();
  const params: string[] = [];
  let where = "";
  if (productId) {
    where = "WHERE i.product_id = ?";
    params.push(productId);
  }
  return (await (await getDb()).all(`
    SELECT i.*, p.name AS product_name
    FROM inventory_items i
    JOIN products p ON p.id = i.product_id
    ${where}
    ORDER BY i.created_at DESC
    LIMIT 300
  `, params)).map(mapInventory).map(redactInventorySecret);
}

export async function deleteInventoryItem(itemId: string) {
  const db = await getDb();
  const item = await db.get<any>("SELECT * FROM inventory_items WHERE id = ?", [itemId]);
  if (!item) throw notFound("库存卡密不存在");
  if (!["available", "disabled"].includes(item.status)) {
    throw badRequest("该卡密已被锁定或发货，不能删除");
  }
  await db.run("DELETE FROM inventory_items WHERE id = ?", [itemId]);
  return { ok: true };
}

export async function listOrders() {
  await releaseExpiredReservations();
  return (await (await getDb()).all(`
    SELECT o.*, p.name AS product_name, p.slug AS product_slug
    FROM orders o
    JOIN products p ON p.id = o.product_id
    ORDER BY o.created_at DESC
    LIMIT 300
  `)).map(mapOrder).map((order) => redactOrderSecrets(order, true));
}

export async function getOrderSecrets(orderId: string) {
  const db = await getDb();
  const row = await db.get<any>(`
    SELECT o.*, p.name AS product_name, p.slug AS product_slug
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.id = ?
  `, [orderId]);
  if (!row) throw notFound("订单不存在");
  const order = mapOrder(row);
  if (order.status !== "delivered") return [];

  const items = revealDeliveredPayload(order.deliveredPayload);
  await db.run(`
    INSERT INTO audit_logs (id, actor, action, detail, created_at)
    VALUES (?, 'admin', 'order.secrets.viewed', ?, ?)
  `, [id(), JSON.stringify({ orderNo: order.orderNo, items: items.length }), nowIso()]);
  return items;
}

export async function updateOrderStatus(orderId: string, status: string) {
  if (!["closed", "refunded", "delivered"].includes(status)) {
    throw badRequest("不支持的订单状态");
  }
  const db = await getDb();
  const order = await db.get<any>("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw notFound("订单不存在");
  await db.transaction(async (tx) => {
    if (status === "closed" && order.status === "pending") {
      await tx.run(`
        UPDATE inventory_items
        SET status = 'available', order_id = NULL, reserved_until = NULL
        WHERE order_id = ? AND status = 'reserved'
      `, [orderId]);
    }
    await tx.run("UPDATE orders SET status = ? WHERE id = ?", [status, orderId]);
  });
  return (await listOrders()).find((item) => item.id === orderId);
}

export async function deleteOrder(orderId: string) {
  const db = await getDb();
  const order = await db.get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) throw notFound("订单不存在");
  await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE inventory_items
      SET status = 'available', order_id = NULL, reserved_until = NULL
      WHERE order_id = ? AND status = 'reserved'
    `, [orderId]);
    await tx.run(`
      UPDATE inventory_items
      SET order_id = NULL, reserved_until = NULL
      WHERE order_id = ? AND status != 'reserved'
    `, [orderId]);
    await tx.run("DELETE FROM orders WHERE id = ?", [orderId]);
  });
  return { ok: true };
}

export async function listCoupons() {
  return (await (await getDb()).all("SELECT * FROM coupons ORDER BY code ASC")).map(mapCoupon);
}

export async function listPaymentMethods() {
  return (await (await getDb()).all(`
    SELECT * FROM payment_methods
    ORDER BY sort_order ASC, name ASC
  `)).map(mapPaymentMethod);
}

export async function upsertPaymentMethod(input: any) {
  const db = await getDb();
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

  const exists = await db.get("SELECT id FROM payment_methods WHERE id = ?", [methodId]);
  if (exists) {
    await db.run(`
      UPDATE payment_methods
      SET code = ?, name = ?, icon = ?, description = ?,
        sort_order = ?, is_active = ?
      WHERE id = ?
    `, [payload.code, payload.name, payload.icon, payload.description, payload.sortOrder, payload.isActive, payload.id]);
  } else {
    await db.run(`
      INSERT INTO payment_methods (id, code, name, icon, description, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [payload.id, payload.code, payload.name, payload.icon, payload.description, payload.sortOrder, payload.isActive]);
  }
  return (await listPaymentMethods()).find((method) => method.id === methodId);
}

export async function deletePaymentMethod(methodId: string) {
  const db = await getDb();
  const method = await db.get<any>("SELECT * FROM payment_methods WHERE id = ?", [methodId]);
  if (!method) throw notFound("支付方式不存在");
  const activeCount = await db.get<any>("SELECT COUNT(*) AS count FROM payment_methods WHERE is_active = 1");
  if (method.is_active && Number(activeCount?.count || 0) <= 1) throw badRequest("至少需要保留一个启用的支付方式");
  await db.run("DELETE FROM payment_methods WHERE id = ?", [methodId]);
  return { ok: true };
}

export async function upsertCoupon(input: any) {
  const db = await getDb();
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
  if (payload.type === "percent" && payload.value >= 100) {
    throw badRequest("百分比优惠不能大于或等于 100%");
  }

  const exists = await db.get("SELECT id FROM coupons WHERE id = ?", [couponId]);
  if (exists) {
    await db.run(`
      UPDATE coupons SET code = ?, type = ?, value = ?,
        min_amount_cents = ?, total_limit = ?,
        starts_at = ?, ends_at = ?, is_active = ?
      WHERE id = ?
    `, [
      payload.code,
      payload.type,
      payload.value,
      payload.minAmountCents,
      payload.totalLimit,
      payload.startsAt,
      payload.endsAt,
      payload.isActive,
      payload.id
    ]);
  } else {
    await db.run(`
      INSERT INTO coupons (id, code, type, value, min_amount_cents, total_limit, used_count, starts_at, ends_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `, [
      payload.id,
      payload.code,
      payload.type,
      payload.value,
      payload.minAmountCents,
      payload.totalLimit,
      payload.startsAt,
      payload.endsAt,
      payload.isActive
    ]);
  }
  return (await listCoupons()).find((coupon) => coupon.id === couponId);
}

export async function deleteCoupon(couponId: string) {
  const db = await getDb();
  const coupon = await db.get("SELECT id FROM coupons WHERE id = ?", [couponId]);
  if (!coupon) throw notFound("优惠券不存在");
  await db.run("DELETE FROM coupons WHERE id = ?", [couponId]);
  return { ok: true };
}

export async function listAnnouncements() {
  return (await (await getDb()).all("SELECT * FROM announcements ORDER BY created_at DESC")).map(mapAnnouncement);
}

export async function upsertAnnouncement(input: any) {
  const db = await getDb();
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

  const exists = await db.get("SELECT id FROM announcements WHERE id = ?", [announcementId]);
  if (exists) {
    await db.run(`
      UPDATE announcements
      SET title = ?, content = ?, level = ?, is_active = ?
      WHERE id = ?
    `, [payload.title, payload.content, payload.level, payload.isActive, payload.id]);
  } else {
    await db.run(`
      INSERT INTO announcements (id, title, content, level, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [payload.id, payload.title, payload.content, payload.level, payload.isActive, payload.now]);
  }
  return (await listAnnouncements()).find((announcement) => announcement.id === announcementId);
}

export async function deleteAnnouncement(announcementId: string) {
  const db = await getDb();
  const announcement = await db.get("SELECT id FROM announcements WHERE id = ?", [announcementId]);
  if (!announcement) throw notFound("公告不存在");
  await db.run("DELETE FROM announcements WHERE id = ?", [announcementId]);
  return { ok: true };
}

export async function getSettings() {
  const rows = await (await getDb()).all<{ key: string; value: string }>("SELECT `key`, value FROM settings ORDER BY `key` ASC");
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function updateSettings(settings: Record<string, string>) {
  const db = await getDb();
  const allowed = ["store_name", "store_slogan", "support_email", "payment_notice", "checkout_tips", "support_hours", "stock_warning", "store_theme"];
  for (const key of allowed) {
    if (settings[key] === undefined) continue;
    const existing = await db.get("SELECT value FROM settings WHERE `key` = ?", [key]);
    if (existing) {
      await db.run("UPDATE settings SET value = ? WHERE `key` = ?", [String(settings[key]), key]);
    } else {
      await db.run("INSERT INTO settings (`key`, value) VALUES (?, ?)", [key, String(settings[key])]);
    }
  }
  return getSettings();
}
