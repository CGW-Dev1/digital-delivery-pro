import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { z } from "zod";
import { createOrder, confirmMockPayment, getOrderByNo, getProductBySlug, getStorefront } from "./storeService";
import {
  getCustomerById,
  listCustomerOrders,
  listGuestOrdersByContact,
  loginCustomer,
  registerCustomer,
  verifyCustomerToken
} from "./customerService";
import {
  addInventory,
  deleteAnnouncement,
  deleteCategory,
  deleteCoupon,
  deleteInventoryItem,
  deleteOrder,
  deletePaymentMethod,
  deleteProduct,
  getDashboard,
  getSettings,
  listAdminProducts,
  listAnnouncements,
  listCategories,
  listCoupons,
  listInventory,
  listOrders,
  listPaymentMethods,
  login,
  updateOrderStatus,
  updateSettings,
  upsertAnnouncement,
  upsertCategory,
  upsertCoupon,
  upsertPaymentMethod,
  upsertProduct,
  verifyToken
} from "./adminService";
import { AppError } from "./errors";

declare global {
  namespace Express {
    interface Request {
      admin?: { sub: string; username: string; role: string };
      customer?: { sub: string; email: string; name: string; kind?: string };
    }
  }
}

const orderSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(50),
  contact: z.string().min(3).max(120),
  buyerNote: z.string().max(500).optional(),
  couponCode: z.string().max(40).optional(),
  paymentMethod: z.string().max(30).optional()
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const customerAuthSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().max(60).optional()
});

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.cookies.admin_token;
  if (!token) {
    next(new AppError(401, "UNAUTHORIZED", "请先登录后台"));
    return;
  }
  try {
    req.admin = verifyToken(token);
    next();
  } catch (error) {
    next(new AppError(401, "UNAUTHORIZED", error instanceof Error ? error.message : "登录状态失效"));
  }
}

function getBearerToken(req: Request) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function optionalCustomer(req: Request, _res: Response, next: NextFunction) {
  const token = getBearerToken(req);
  if (!token) {
    next();
    return;
  }
  try {
    req.customer = verifyCustomerToken(token);
    next();
  } catch (error) {
    next(new AppError(401, "UNAUTHORIZED", error instanceof Error ? error.message : "登录状态失效"));
  }
}

function requireCustomer(req: Request, _res: Response, next: NextFunction) {
  const token = getBearerToken(req);
  if (!token) {
    next(new AppError(401, "UNAUTHORIZED", "请先登录"));
    return;
  }
  try {
    req.customer = verifyCustomerToken(token);
    next();
  } catch (error) {
    next(new AppError(401, "UNAUTHORIZED", error instanceof Error ? error.message : "登录状态失效"));
  }
}

export function createApp() {
  const app = express();

  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "digital-delivery-pro" });
  });

  app.get("/api/store", asyncRoute((_req, res) => {
    res.json(getStorefront());
  }));

  app.get("/api/products/:slug", asyncRoute((req, res) => {
    res.json(getProductBySlug(String(req.params.slug)));
  }));

  app.post("/api/orders", optionalCustomer, asyncRoute((req, res) => {
    const parsed = orderSchema.parse(req.body);
    const order = createOrder({
      ...parsed,
      userId: req.customer?.sub,
      clientIp: req.ip
    });
    res.status(201).json(order);
  }));

  app.get("/api/orders/:orderNo", asyncRoute((req, res) => {
    res.json(getOrderByNo(String(req.params.orderNo), {
      contact: req.query.contact ? String(req.query.contact) : undefined,
      includeSecrets: true
    }));
  }));

  app.post("/api/payments/mock/:orderNo/confirm", asyncRoute((req, res) => {
    res.json(confirmMockPayment(String(req.params.orderNo)));
  }));

  app.post("/api/auth/register", asyncRoute((req, res) => {
    const parsed = customerAuthSchema.parse(req.body);
    res.status(201).json(registerCustomer(parsed));
  }));

  app.post("/api/auth/login", asyncRoute((req, res) => {
    const parsed = customerAuthSchema.pick({ email: true, password: true }).parse(req.body);
    res.json(loginCustomer(parsed));
  }));

  app.get("/api/auth/me", requireCustomer, asyncRoute((req, res) => {
    res.json(getCustomerById(req.customer!.sub));
  }));

  app.get("/api/account/orders", requireCustomer, asyncRoute((req, res) => {
    res.json(listCustomerOrders(req.customer!.sub));
  }));

  app.get("/api/guest/orders", asyncRoute((req, res) => {
    res.json(listGuestOrdersByContact(String(req.query.contact || "")));
  }));

  app.post("/api/admin/login", asyncRoute((req, res) => {
    const parsed = loginSchema.parse(req.body);
    const result = login(parsed.username, parsed.password);
    res.cookie("admin_token", result.token, { httpOnly: true, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 });
    res.json(result);
  }));

  app.use("/api/admin", requireAdmin);

  app.get("/api/admin/me", (req, res) => {
    res.json(req.admin);
  });

  app.get("/api/admin/dashboard", asyncRoute((_req, res) => res.json(getDashboard())));
  app.get("/api/admin/categories", asyncRoute((_req, res) => res.json(listCategories())));
  app.post("/api/admin/categories", asyncRoute((req, res) => res.status(201).json(upsertCategory(req.body))));
  app.patch("/api/admin/categories/:id", asyncRoute((req, res) => res.json(upsertCategory({ ...req.body, id: String(req.params.id) }))));
  app.delete("/api/admin/categories/:id", asyncRoute((req, res) => res.json(deleteCategory(String(req.params.id)))));
  app.get("/api/admin/products", asyncRoute((_req, res) => res.json(listAdminProducts())));
  app.post("/api/admin/products", asyncRoute((req, res) => res.status(201).json(upsertProduct(req.body))));
  app.patch("/api/admin/products/:id", asyncRoute((req, res) => res.json(upsertProduct({ ...req.body, id: String(req.params.id) }))));
  app.delete("/api/admin/products/:id", asyncRoute((req, res) => res.json(deleteProduct(String(req.params.id)))));
  app.post("/api/admin/products/:id/inventory", asyncRoute((req, res) => {
    const lines = Array.isArray(req.body.lines) ? req.body.lines : String(req.body.lines || "").split(/\r?\n/);
    res.status(201).json(addInventory(String(req.params.id), lines));
  }));
  app.get("/api/admin/inventory", asyncRoute((req, res) => {
    res.json(listInventory(req.query.productId ? String(req.query.productId) : undefined));
  }));
  app.delete("/api/admin/inventory/:id", asyncRoute((req, res) => res.json(deleteInventoryItem(String(req.params.id)))));
  app.get("/api/admin/orders", asyncRoute((_req, res) => res.json(listOrders())));
  app.patch("/api/admin/orders/:id", asyncRoute((req, res) => res.json(updateOrderStatus(String(req.params.id), req.body.status))));
  app.delete("/api/admin/orders/:id", asyncRoute((req, res) => res.json(deleteOrder(String(req.params.id)))));
  app.get("/api/admin/coupons", asyncRoute((_req, res) => res.json(listCoupons())));
  app.post("/api/admin/coupons", asyncRoute((req, res) => res.status(201).json(upsertCoupon(req.body))));
  app.patch("/api/admin/coupons/:id", asyncRoute((req, res) => res.json(upsertCoupon({ ...req.body, id: String(req.params.id) }))));
  app.delete("/api/admin/coupons/:id", asyncRoute((req, res) => res.json(deleteCoupon(String(req.params.id)))));
  app.get("/api/admin/payment-methods", asyncRoute((_req, res) => res.json(listPaymentMethods())));
  app.post("/api/admin/payment-methods", asyncRoute((req, res) => res.status(201).json(upsertPaymentMethod(req.body))));
  app.patch("/api/admin/payment-methods/:id", asyncRoute((req, res) => res.json(upsertPaymentMethod({ ...req.body, id: String(req.params.id) }))));
  app.delete("/api/admin/payment-methods/:id", asyncRoute((req, res) => res.json(deletePaymentMethod(String(req.params.id)))));
  app.get("/api/admin/announcements", asyncRoute((_req, res) => res.json(listAnnouncements())));
  app.post("/api/admin/announcements", asyncRoute((req, res) => res.status(201).json(upsertAnnouncement(req.body))));
  app.patch("/api/admin/announcements/:id", asyncRoute((req, res) => res.json(upsertAnnouncement({ ...req.body, id: String(req.params.id) }))));
  app.delete("/api/admin/announcements/:id", asyncRoute((req, res) => res.json(deleteAnnouncement(String(req.params.id)))));
  app.get("/api/admin/settings", asyncRoute((_req, res) => res.json(getSettings())));
  app.patch("/api/admin/settings", asyncRoute((req, res) => res.json(updateSettings(req.body))));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(422).json({ code: "VALIDATION_ERROR", message: "提交内容不完整或格式错误", issues: error.issues });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ code: "INTERNAL_ERROR", message: "服务器暂时不可用" });
  });

  return app;
}
