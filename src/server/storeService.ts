import { customAlphabet } from "nanoid";
import type { StorefrontPayload } from "../shared/types";
import { config } from "./config";
import { addMinutesIso, type DbClient, getDb, nowIso } from "./db";
import { badRequest, notFound } from "./errors";
import { mapAnnouncement, mapCategory, mapCoupon, mapOrder, mapPaymentMethod, mapProduct } from "./mappers";
import { createPaymentToken, encryptSecret, hashPaymentToken, redactOrderSecrets, revealOrderSecrets, verifyPaymentToken } from "./security";

const publicId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 10);
const dbId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

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

export async function releaseExpiredReservations(dbOverride?: DbClient) {
  const db = dbOverride || await getDb();
  const now = nowIso();
  await db.transaction(async (tx) => {
    const expiredOrders = await tx.all<{ id: string }>(`
      SELECT id FROM orders
      WHERE status = 'pending' AND expires_at < ?
      ${tx.dialect === "mysql" ? "FOR UPDATE" : ""}
    `, [now]);

    if (expiredOrders.length === 0) return;

    const orderIds = expiredOrders.map((order) => order.id);
    const placeholders = orderIds.map(() => "?").join(",");
    await tx.run(`
      UPDATE inventory_items
      SET status = 'available', order_id = NULL, reserved_until = NULL
      WHERE status = 'reserved' AND order_id IN (${placeholders})
    `, orderIds);
    await tx.run(`
      UPDATE orders
      SET status = 'closed'
      WHERE id IN (${placeholders}) AND status = 'pending'
    `, orderIds);
  });
}

export async function getStorefront(): Promise<StorefrontPayload> {
  await releaseExpiredReservations();
  const db = await getDb();
  const settingsRows = await db.all<{ key: string; value: string }>("SELECT `key`, value FROM settings");
  const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
  const categories = (await db.all(`
    SELECT * FROM categories
    WHERE is_active = 1
    ORDER BY sort_order ASC, name ASC
  `)).map(mapCategory);
  const products = (await db.all(`
    SELECT
      p.*,
      c.name AS category_name,
      COALESCE(inv.stock, 0) AS stock,
      COALESCE(inv.sold, 0) AS sold
    FROM products p
    JOIN categories c ON c.id = p.category_id
    ${productStockJoin}
    WHERE p.is_active = 1 AND c.is_active = 1
    ORDER BY p.sort_order ASC, p.created_at DESC
  `)).map(mapProduct);
  const announcements = (await db.all(`
    SELECT * FROM announcements
    WHERE is_active = 1
    ORDER BY created_at DESC
  `)).map(mapAnnouncement);
  const paymentMethods = (await db.all(`
    SELECT * FROM payment_methods
    WHERE is_active = 1
    ORDER BY sort_order ASC, name ASC
  `)).map(mapPaymentMethod);

  return { settings, announcements, categories, products, paymentMethods };
}

export async function getProductBySlug(slug: string) {
  await releaseExpiredReservations();
  const db = await getDb();
  const row = await db.get(`
    SELECT
      p.*,
      c.name AS category_name,
      COALESCE(inv.stock, 0) AS stock,
      COALESCE(inv.sold, 0) AS sold
    FROM products p
    JOIN categories c ON c.id = p.category_id
    ${productStockJoin}
    WHERE p.slug = ? AND p.is_active = 1 AND c.is_active = 1
  `, [slug]);
  if (!row) throw notFound("商品不存在或已下架");
  return mapProduct(row);
}

async function findCoupon(db: DbClient, code: string | null | undefined, subtotalCents: number) {
  if (!code) return { coupon: null, discountCents: 0 };
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { coupon: null, discountCents: 0 };

  const row = await db.get(`
    SELECT * FROM coupons
    WHERE code = ? AND is_active = 1
    ${db.dialect === "mysql" ? "FOR UPDATE" : ""}
  `, [normalized]);
  if (!row) throw badRequest("优惠券不存在或不可用", "COUPON_INVALID");
  const coupon = mapCoupon(row);
  const now = nowIso();

  if (coupon.startsAt && coupon.startsAt > now) throw badRequest("优惠券尚未开始", "COUPON_NOT_STARTED");
  if (coupon.endsAt && coupon.endsAt < now) throw badRequest("优惠券已过期", "COUPON_EXPIRED");
  if (coupon.totalLimit > 0 && coupon.usedCount >= coupon.totalLimit) throw badRequest("优惠券已被领完", "COUPON_EXHAUSTED");
  if (subtotalCents < coupon.minAmountCents) throw badRequest("订单金额未达到优惠券门槛", "COUPON_MIN_AMOUNT");

  const rawDiscountCents = coupon.type === "percent"
    ? Math.floor((subtotalCents * coupon.value) / 100)
    : Math.min(coupon.value, subtotalCents);
  const discountCents = Math.max(0, Math.min(rawDiscountCents, subtotalCents - 1));

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

export async function createOrder(input: CreateOrderInput) {
  await releaseExpiredReservations();
  const db = await getDb();
  const now = nowIso();
  const expiresAt = addMinutesIso(config.reservationMinutes);
  const orderNo = `DD${new Date().toISOString().slice(2, 10).replace(/-/g, "")}${publicId()}`;

  return db.transaction(async (tx) => {
    const productRow = await tx.get(`
      SELECT * FROM products
      WHERE id = ? AND is_active = 1
      ${tx.dialect === "mysql" ? "FOR UPDATE" : ""}
    `, [input.productId]);
    if (!productRow) throw notFound("商品不存在或已下架");
    const product = mapProduct({ ...productRow, stock: 0, sold: 0 });

    if (input.quantity < 1 || input.quantity > product.buyLimit) {
      throw badRequest(`单次购买数量需在 1-${product.buyLimit} 之间`, "QUANTITY_LIMIT");
    }
    if (product.priceCents <= 0) {
      throw badRequest("商品价格必须大于 0", "INVALID_PRODUCT_PRICE");
    }

    const stockRows = await tx.all<{ id: string }>(`
      SELECT id FROM inventory_items
      WHERE product_id = ? AND status = 'available'
      ORDER BY created_at ASC
      LIMIT ?
      ${tx.dialect === "mysql" ? "FOR UPDATE" : ""}
    `, [product.id, input.quantity]);

    if (stockRows.length < input.quantity) {
      throw badRequest("库存不足，请减少数量或稍后再试", "OUT_OF_STOCK");
    }

    const subtotalCents = product.priceCents * input.quantity;
    const { coupon, discountCents } = await findCoupon(tx, input.couponCode, subtotalCents);
    const paymentMethod = await tx.get(`
      SELECT code FROM payment_methods
      WHERE code = ? AND is_active = 1
    `, [input.paymentMethod || "mockpay"]);
    if (!paymentMethod) throw badRequest("支付方式不可用，请重新选择", "PAYMENT_METHOD_DISABLED");
    const totalCents = subtotalCents - discountCents;
    if (totalCents <= 0) {
      throw badRequest("订单实付金额必须大于 0", "INVALID_ORDER_TOTAL");
    }
    const orderId = dbId();
    const paymentToken = createPaymentToken();

    await tx.run(`
      INSERT INTO orders (
        id, order_no, user_id, product_id, quantity, unit_price_cents, discount_cents,
        total_cents, contact, buyer_note, payment_method, status, coupon_code,
        delivered_payload, created_at, expires_at, payment_token_hash, client_ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '[]', ?, ?, ?, ?)
    `, [
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
      hashPaymentToken(paymentToken),
      input.clientIp || ""
    ]);

    for (const stock of stockRows) {
      await tx.run(`
        UPDATE inventory_items
        SET status = 'reserved', order_id = ?, reserved_until = ?
        WHERE id = ?
      `, [orderId, expiresAt, stock.id]);
    }

    await tx.run(`
      INSERT INTO audit_logs (id, actor, action, detail, created_at)
      VALUES (?, 'buyer', 'order.created', ?, ?)
    `, [dbId(), JSON.stringify({ orderNo, quantity: input.quantity, totalCents }), now]);

    const order = await getOrderByNo(orderNo, { includeSecrets: false }, tx);
    return { ...order, paymentToken };
  });
}

export async function confirmMockPayment(orderNo: string, paymentToken?: string) {
  await releaseExpiredReservations();
  if (!config.allowMockPayment) {
    throw badRequest("生产环境未启用 MockPay，不能使用演示支付确认", "MOCK_PAYMENT_DISABLED");
  }
  const db = await getDb();

  return db.transaction(async (tx) => {
    const orderRow = await tx.get<any>(`
      SELECT * FROM orders
      WHERE order_no = ?
      ${tx.dialect === "mysql" ? "FOR UPDATE" : ""}
    `, [orderNo]);
    if (!orderRow) throw notFound("订单不存在");
    if (!verifyPaymentToken(paymentToken, orderRow.payment_token_hash)) {
      throw badRequest("支付确认令牌无效，请重新下单", "PAYMENT_TOKEN_INVALID");
    }
    if (orderRow.payment_method !== "mockpay") {
      throw badRequest("当前支付方式不能使用 MockPay 确认", "PAYMENT_METHOD_MISMATCH");
    }
    if (Number(orderRow.total_cents) <= 0) {
      throw badRequest("订单实付金额异常，不能发货", "INVALID_ORDER_TOTAL");
    }
    if (orderRow.status === "delivered") return getOrderByNo(orderNo, { includeSecrets: true, trusted: true }, tx);
    if (orderRow.status !== "pending") throw badRequest("订单当前状态不能支付", "ORDER_NOT_PAYABLE");
    if (orderRow.expires_at < nowIso()) {
      throw badRequest("订单已过期，库存已释放", "ORDER_EXPIRED");
    }

    const reserved = await tx.all<{ id: string; secret: string }>(`
      SELECT id, secret FROM inventory_items
      WHERE order_id = ? AND status = 'reserved'
      ORDER BY created_at ASC
      ${tx.dialect === "mysql" ? "FOR UPDATE" : ""}
    `, [orderRow.id]);

    if (reserved.length < orderRow.quantity) {
      throw badRequest("预占库存异常，请重新下单", "RESERVED_STOCK_MISSING");
    }

    const deliveredAt = nowIso();
    const payload = reserved.map((item) => ({
      id: item.id,
      secret: encryptSecret(item.secret),
      deliveredAt
    }));

    for (const item of reserved) {
      await tx.run(`
        UPDATE inventory_items
        SET status = 'delivered', delivered_at = ?, reserved_until = NULL
        WHERE id = ?
      `, [deliveredAt, item.id]);
    }

    await tx.run(`
      UPDATE orders
      SET status = 'delivered', paid_at = ?, delivered_at = ?, delivered_payload = ?
      WHERE id = ?
    `, [deliveredAt, deliveredAt, JSON.stringify(payload), orderRow.id]);

    if (orderRow.coupon_code) {
      await tx.run("UPDATE coupons SET used_count = used_count + 1 WHERE code = ?", [orderRow.coupon_code]);
    }

    await tx.run(`
      INSERT INTO audit_logs (id, actor, action, detail, created_at)
      VALUES (?, 'system', 'order.delivered', ?, ?)
    `, [dbId(), JSON.stringify({ orderNo, items: payload.length }), deliveredAt]);

    return getOrderByNo(orderNo, { includeSecrets: true, trusted: true }, tx);
  });
}

export async function getOrderByNo(
  orderNo: string,
  options: { contact?: string; customerId?: string; includeSecrets?: boolean; trusted?: boolean } = {},
  dbOverride?: DbClient
) {
  const db = dbOverride || await getDb();
  if (!dbOverride) await releaseExpiredReservations(db);
  const row = await db.get(`
    SELECT
      o.*,
      p.name AS product_name,
      p.slug AS product_slug
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.order_no = ?
  `, [orderNo]);
  if (!row) throw notFound("订单不存在");
  const order = mapOrder(row);
  if (options.contact && order.contact !== options.contact.trim()) {
    throw notFound("订单不存在或联系方式不匹配");
  }
  const isCustomerOwner = Boolean(options.customerId && order.userId && order.userId === options.customerId);
  const isContactOwner = Boolean(options.contact && order.contact === options.contact.trim());
  const canRevealSecrets = Boolean(options.trusted || isCustomerOwner || isContactOwner);
  if (!options.includeSecrets) return redactOrderSecrets(order);
  if (!canRevealSecrets) throw badRequest("需要订单联系方式或登录账号验证", "ORDER_AUTH_REQUIRED");
  return revealOrderSecrets(order);
}
