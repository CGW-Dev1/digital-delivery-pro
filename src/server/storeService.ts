import { customAlphabet } from "nanoid";
import type { StorefrontPayload } from "../shared/types";
import { config } from "./config";
import { addMinutesIso, getDb, nowIso } from "./db";
import { badRequest, notFound } from "./errors";
import { mapAnnouncement, mapCategory, mapCoupon, mapOrder, mapPaymentMethod, mapProduct } from "./mappers";

const publicId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 10);
const dbId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export function releaseExpiredReservations() {
  const db = getDb();
  const now = nowIso();
  const tx = db.transaction(() => {
    const expiredOrders = db.prepare(`
      SELECT id FROM orders
      WHERE status = 'pending' AND expires_at < ?
    `).all(now) as Array<{ id: string }>;

    if (expiredOrders.length === 0) return;

    const orderIds = expiredOrders.map((order) => order.id);
    const placeholders = orderIds.map(() => "?").join(",");
    db.prepare(`
      UPDATE inventory_items
      SET status = 'available', order_id = NULL, reserved_until = NULL
      WHERE status = 'reserved' AND order_id IN (${placeholders})
    `).run(...orderIds);
    db.prepare(`
      UPDATE orders
      SET status = 'closed'
      WHERE id IN (${placeholders}) AND status = 'pending'
    `).run(...orderIds);
  });
  tx();
}

export function getStorefront(): StorefrontPayload {
  releaseExpiredReservations();
  const db = getDb();
  const settingsRows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
  const categories = (db.prepare(`
    SELECT * FROM categories
    WHERE is_active = 1
    ORDER BY sort_order ASC, name ASC
  `).all() as any[]).map(mapCategory);
  const products = (db.prepare(`
    SELECT
      p.*,
      c.name AS category_name,
      COALESCE(SUM(CASE WHEN i.status = 'available' THEN 1 ELSE 0 END), 0) AS stock,
      COALESCE(SUM(CASE WHEN i.status = 'delivered' THEN 1 ELSE 0 END), 0) AS sold
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory_items i ON i.product_id = p.id
    WHERE p.is_active = 1 AND c.is_active = 1
    GROUP BY p.id
    ORDER BY p.sort_order ASC, p.created_at DESC
  `).all() as any[]).map(mapProduct);
  const announcements = (db.prepare(`
    SELECT * FROM announcements
    WHERE is_active = 1
    ORDER BY created_at DESC
  `).all() as any[]).map(mapAnnouncement);
  const paymentMethods = (db.prepare(`
    SELECT * FROM payment_methods
    WHERE is_active = 1
    ORDER BY sort_order ASC, name ASC
  `).all() as any[]).map(mapPaymentMethod);

  return { settings, announcements, categories, products, paymentMethods };
}

export function getProductBySlug(slug: string) {
  releaseExpiredReservations();
  const row = getDb().prepare(`
    SELECT
      p.*,
      c.name AS category_name,
      COALESCE(SUM(CASE WHEN i.status = 'available' THEN 1 ELSE 0 END), 0) AS stock,
      COALESCE(SUM(CASE WHEN i.status = 'delivered' THEN 1 ELSE 0 END), 0) AS sold
    FROM products p
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory_items i ON i.product_id = p.id
    WHERE p.slug = ? AND p.is_active = 1 AND c.is_active = 1
    GROUP BY p.id
  `).get(slug);
  if (!row) throw notFound("商品不存在或已下架");
  return mapProduct(row);
}

function findCoupon(code: string | null | undefined, subtotalCents: number) {
  if (!code) return { coupon: null, discountCents: 0 };
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { coupon: null, discountCents: 0 };

  const row = getDb().prepare("SELECT * FROM coupons WHERE code = ? AND is_active = 1").get(normalized);
  if (!row) throw badRequest("优惠券不存在或不可用", "COUPON_INVALID");
  const coupon = mapCoupon(row);
  const now = nowIso();

  if (coupon.startsAt && coupon.startsAt > now) throw badRequest("优惠券尚未开始", "COUPON_NOT_STARTED");
  if (coupon.endsAt && coupon.endsAt < now) throw badRequest("优惠券已过期", "COUPON_EXPIRED");
  if (coupon.totalLimit > 0 && coupon.usedCount >= coupon.totalLimit) throw badRequest("优惠券已被领完", "COUPON_EXHAUSTED");
  if (subtotalCents < coupon.minAmountCents) throw badRequest("订单金额未达到优惠券门槛", "COUPON_MIN_AMOUNT");

  const discountCents = coupon.type === "percent"
    ? Math.floor((subtotalCents * coupon.value) / 100)
    : Math.min(coupon.value, subtotalCents);

  return { coupon, discountCents };
}

export interface CreateOrderInput {
  productId: string;
  quantity: number;
  contact: string;
  userId?: string;
  buyerNote?: string;
  couponCode?: string;
  paymentMethod?: string;
  clientIp?: string;
}

export function createOrder(input: CreateOrderInput) {
  releaseExpiredReservations();
  const db = getDb();
  const now = nowIso();
  const expiresAt = addMinutesIso(config.reservationMinutes);
  const orderNo = `DD${new Date().toISOString().slice(2, 10).replace(/-/g, "")}${publicId()}`;

  const tx = db.transaction(() => {
    const productRow = db.prepare(`
      SELECT * FROM products
      WHERE id = ? AND is_active = 1
    `).get(input.productId);
    if (!productRow) throw notFound("商品不存在或已下架");
    const product = mapProduct({ ...productRow, stock: 0, sold: 0 });

    if (input.quantity < 1 || input.quantity > product.buyLimit) {
      throw badRequest(`单次购买数量需在 1-${product.buyLimit} 之间`, "QUANTITY_LIMIT");
    }

    const stockRows = db.prepare(`
      SELECT id FROM inventory_items
      WHERE product_id = ? AND status = 'available'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(product.id, input.quantity) as Array<{ id: string }>;

    if (stockRows.length < input.quantity) {
      throw badRequest("库存不足，请减少数量或稍后再试", "OUT_OF_STOCK");
    }

    const subtotalCents = product.priceCents * input.quantity;
    const { coupon, discountCents } = findCoupon(input.couponCode, subtotalCents);
    const paymentMethod = db.prepare(`
      SELECT code FROM payment_methods
      WHERE code = ? AND is_active = 1
    `).get(input.paymentMethod || "mockpay");
    if (!paymentMethod) throw badRequest("支付方式不可用，请重新选择", "PAYMENT_METHOD_DISABLED");
    const totalCents = Math.max(0, subtotalCents - discountCents);
    const orderId = dbId();

    db.prepare(`
      INSERT INTO orders (
        id, order_no, user_id, product_id, quantity, unit_price_cents, discount_cents,
        total_cents, contact, buyer_note, payment_method, status, coupon_code,
        delivered_payload, created_at, expires_at, client_ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '[]', ?, ?, ?)
    `).run(
      orderId,
      orderNo,
      input.userId || null,
      product.id,
      input.quantity,
      product.priceCents,
      discountCents,
      totalCents,
      input.contact.trim(),
      input.buyerNote?.trim() || "",
      input.paymentMethod || "mockpay",
      coupon?.code || null,
      now,
      expiresAt,
      input.clientIp || ""
    );

    const reserve = db.prepare(`
      UPDATE inventory_items
      SET status = 'reserved', order_id = ?, reserved_until = ?
      WHERE id = ?
    `);
    stockRows.forEach((stock) => reserve.run(orderId, expiresAt, stock.id));

    db.prepare(`
      INSERT INTO audit_logs (id, actor, action, detail, created_at)
      VALUES (?, 'buyer', 'order.created', ?, ?)
    `).run(dbId(), JSON.stringify({ orderNo, quantity: input.quantity, totalCents }), now);

    return getOrderByNo(orderNo, { includeSecrets: false });
  });

  return tx();
}

export function confirmMockPayment(orderNo: string) {
  releaseExpiredReservations();
  const db = getDb();
  const tx = db.transaction(() => {
    const orderRow = db.prepare("SELECT * FROM orders WHERE order_no = ?").get(orderNo) as any;
    if (!orderRow) throw notFound("订单不存在");
    if (orderRow.status === "delivered") return getOrderByNo(orderNo, { includeSecrets: true });
    if (orderRow.status !== "pending") throw badRequest("订单当前状态不能支付", "ORDER_NOT_PAYABLE");
    if (orderRow.expires_at < nowIso()) {
      releaseExpiredReservations();
      throw badRequest("订单已过期，库存已释放", "ORDER_EXPIRED");
    }

    const reserved = db.prepare(`
      SELECT id, secret FROM inventory_items
      WHERE order_id = ? AND status = 'reserved'
      ORDER BY created_at ASC
    `).all(orderRow.id) as Array<{ id: string; secret: string }>;

    if (reserved.length < orderRow.quantity) {
      throw badRequest("预占库存异常，请重新下单", "RESERVED_STOCK_MISSING");
    }

    const deliveredAt = nowIso();
    const payload = reserved.map((item) => ({
      id: item.id,
      secret: item.secret,
      deliveredAt
    }));

    const markDelivered = db.prepare(`
      UPDATE inventory_items
      SET status = 'delivered', delivered_at = ?, reserved_until = NULL
      WHERE id = ?
    `);
    reserved.forEach((item) => markDelivered.run(deliveredAt, item.id));

    db.prepare(`
      UPDATE orders
      SET status = 'delivered', paid_at = ?, delivered_at = ?, delivered_payload = ?
      WHERE id = ?
    `).run(deliveredAt, deliveredAt, JSON.stringify(payload), orderRow.id);

    if (orderRow.coupon_code) {
      db.prepare("UPDATE coupons SET used_count = used_count + 1 WHERE code = ?").run(orderRow.coupon_code);
    }

    db.prepare(`
      INSERT INTO audit_logs (id, actor, action, detail, created_at)
      VALUES (?, 'system', 'order.delivered', ?, ?)
    `).run(dbId(), JSON.stringify({ orderNo, items: payload.length }), deliveredAt);

    return getOrderByNo(orderNo, { includeSecrets: true });
  });

  return tx();
}

export function getOrderByNo(orderNo: string, options: { contact?: string; includeSecrets?: boolean } = {}) {
  releaseExpiredReservations();
  const row = getDb().prepare(`
    SELECT
      o.*,
      p.name AS product_name,
      p.slug AS product_slug
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.order_no = ?
  `).get(orderNo);
  if (!row) throw notFound("订单不存在");
  const order = mapOrder(row);
  if (options.contact && order.contact !== options.contact.trim()) {
    throw notFound("订单不存在或联系方式不匹配");
  }
  if (!options.includeSecrets && order.status !== "delivered") {
    return { ...order, deliveredPayload: [] };
  }
  return order;
}
