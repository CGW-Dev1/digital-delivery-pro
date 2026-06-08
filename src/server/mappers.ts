import type { Announcement, Category, Coupon, InventoryItem, Order, PaymentMethod, Product } from "../shared/types";

export function bool(value: number | boolean) {
  return Boolean(value);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function mapCategory(row: any): Category {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sort_order,
    isActive: bool(row.is_active)
  };
}

export function mapProduct(row: any): Product {
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    name: row.name,
    slug: row.slug,
    subtitle: row.subtitle,
    description: row.description,
    priceCents: row.price_cents,
    marketPriceCents: row.market_price_cents,
    coverUrl: row.cover_url,
    tags: parseJson<string[]>(row.tags_json, []),
    deliveryType: row.delivery_type,
    buyLimit: row.buy_limit,
    requireContact: bool(row.require_contact),
    isActive: bool(row.is_active),
    stock: Number(row.stock ?? 0),
    sold: Number(row.sold ?? 0),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapAnnouncement(row: any): Announcement {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    level: row.level,
    isActive: bool(row.is_active),
    createdAt: row.created_at
  };
}

export function mapCoupon(row: any): Coupon {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    minAmountCents: row.min_amount_cents,
    totalLimit: row.total_limit,
    usedCount: row.used_count,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isActive: bool(row.is_active)
  };
}

export function mapPaymentMethod(row: any): PaymentMethod {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    icon: row.icon,
    description: row.description,
    sortOrder: row.sort_order,
    isActive: bool(row.is_active)
  };
}

export function mapInventory(row: any): InventoryItem {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    secret: row.secret,
    status: row.status,
    orderId: row.order_id,
    reservedUntil: row.reserved_until,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at
  };
}

export function mapOrder(row: any): Order {
  return {
    id: row.id,
    orderNo: row.order_no,
    userId: row.user_id ?? null,
    productId: row.product_id,
    productName: row.product_name,
    productSlug: row.product_slug,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    contact: row.contact,
    buyerNote: row.buyer_note,
    paymentMethod: row.payment_method,
    status: row.status,
    couponCode: row.coupon_code,
    deliveredPayload: parseJson(row.delivered_payload, []),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    deliveredAt: row.delivered_at
  };
}
