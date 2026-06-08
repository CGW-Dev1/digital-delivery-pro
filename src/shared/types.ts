export type ProductStatus = "active" | "hidden";
export type InventoryStatus = "available" | "reserved" | "delivered" | "disabled";
export type OrderStatus = "pending" | "paid" | "delivered" | "closed" | "refunded";
export type CouponType = "fixed" | "percent";

export interface Category {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
}

export interface Product {
  id: string;
  categoryId: string;
  categoryName?: string;
  name: string;
  slug: string;
  subtitle: string;
  description: string;
  priceCents: number;
  marketPriceCents: number;
  coverUrl: string;
  tags: string[];
  deliveryType: "card" | "manual";
  buyLimit: number;
  requireContact: boolean;
  isActive: boolean;
  stock: number;
  sold: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  level: "info" | "success" | "warning";
  isActive: boolean;
  createdAt: string;
}

export interface StorefrontPayload {
  settings: Record<string, string>;
  announcements: Announcement[];
  categories: Category[];
  products: Product[];
  paymentMethods: PaymentMethod[];
}

export interface PaymentMethod {
  id: string;
  code: string;
  name: string;
  icon: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

export interface DeliveredItem {
  id: string;
  secret: string;
  deliveredAt: string;
}

export interface Order {
  id: string;
  orderNo: string;
  userId: string | null;
  productId: string;
  productName: string;
  productSlug: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  totalCents: number;
  contact: string;
  buyerNote: string;
  paymentMethod: string;
  status: OrderStatus;
  couponCode: string | null;
  deliveredPayload: DeliveredItem[];
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
  paymentToken?: string;
}

export interface Customer {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Coupon {
  id: string;
  code: string;
  type: CouponType;
  value: number;
  minAmountCents: number;
  totalLimit: number;
  usedCount: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
}

export interface InventoryItem {
  id: string;
  productId: string;
  productName?: string;
  secret: string;
  status: InventoryStatus;
  orderId: string | null;
  reservedUntil: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface AdminStats {
  revenueCents: number;
  orderCount: number;
  deliveredCount: number;
  pendingCount: number;
  productCount: number;
  availableStock: number;
}
