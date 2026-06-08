import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { closeDb, getDb } from "../db";

describe("order delivery flow", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddp-"));
    process.env.DATABASE_PATH = path.join(tempDir, "test.sqlite");
  });

  afterEach(async () => {
    await closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  it("reserves stock at order creation and reveals secrets after mock payment", async () => {
    const app = createApp();
    const store = await request(app).get("/api/store").expect(200);
    const product = store.body.products[0];

    const created = await request(app)
      .post("/api/orders")
      .send({
        productId: product.id,
        quantity: 2,
        contact: "buyer@example.com",
        couponCode: "WELCOME10"
      })
      .expect(201);

    expect(created.body.status).toBe("pending");
    expect(created.body.deliveredPayload).toEqual([]);
    expect(created.body.discountCents).toBeGreaterThan(0);
    expect(created.body.paymentToken).toBeTruthy();

    await request(app)
      .post(`/api/payments/mock/${created.body.orderNo}/confirm`)
      .send({ paymentToken: "wrong-token-that-is-long-enough" })
      .expect(400);

    const delivered = await request(app)
      .post(`/api/payments/mock/${created.body.orderNo}/confirm`)
      .send({ paymentToken: created.body.paymentToken })
      .expect(200);

    expect(delivered.body.status).toBe("delivered");
    expect(delivered.body.deliveredPayload).toHaveLength(2);

    const anonymous = await request(app)
      .get(`/api/orders/${created.body.orderNo}`)
      .expect(200);
    expect(anonymous.body.deliveredPayload).toEqual([]);

    const queried = await request(app)
      .get(`/api/orders/${created.body.orderNo}`)
      .query({ contact: "buyer@example.com" })
      .expect(200);

    expect(queried.body.deliveredPayload[0].secret).toContain("KEY-");

    const adminLogin = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "ChangeMe123!" })
      .expect(200);

    const adminOrders = await request(app)
      .get("/api/admin/orders")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .expect(200);
    const adminOrder = adminOrders.body.find((order: any) => order.orderNo === created.body.orderNo);
    expect(adminOrder.deliveredPayload[0].secret).not.toBe(queried.body.deliveredPayload[0].secret);
    expect(adminOrder.deliveredPayload[0].secret).toContain("****");

    const adminSecrets = await request(app)
      .get(`/api/admin/orders/${adminOrder.id}/secrets`)
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .expect(200);
    expect(adminSecrets.body[0].secret).toBe(queried.body.deliveredPayload[0].secret);
  });

  it("requires admin authentication for management APIs", async () => {
    const app = createApp();
    await request(app).get("/api/admin/orders").expect(401);

    const login = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "ChangeMe123!" })
      .expect(200);

    await request(app)
      .get("/api/admin/orders")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);
  });

  it("exposes payment methods and admin category/payment management", async () => {
    const app = createApp();
    const store = await request(app).get("/api/store").expect(200);
    expect(store.body.paymentMethods).toHaveLength(3);

    const login = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "ChangeMe123!" })
      .expect(200);
    const token = login.body.token;

    const category = await request(app)
      .post("/api/admin/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "测试分类", slug: "test-category", sortOrder: 99, isActive: true })
      .expect(201);

    expect(category.body.name).toBe("测试分类");

    const payment = await request(app)
      .post("/api/admin/payment-methods")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "testpay", name: "TestPay", icon: "credit-card", description: "测试支付", sortOrder: 99, isActive: true })
      .expect(201);

    expect(payment.body.code).toBe("testpay");

    const methods = await request(app)
      .get("/api/admin/payment-methods")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(methods.body.some((method: any) => method.code === "testpay")).toBe(true);
  });

  it("supports admin delete operations with relationship guards", async () => {
    const app = createApp();
    const login = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "ChangeMe123!" })
      .expect(200);
    const token = login.body.token;

    const store = await request(app).get("/api/store").expect(200);
    await request(app)
      .delete(`/api/admin/categories/${store.body.categories[0].id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);

    const category = await request(app)
      .post("/api/admin/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Delete Category", slug: "delete-category", sortOrder: 120, isActive: true })
      .expect(201);

    const product = await request(app)
      .post("/api/admin/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        categoryId: category.body.id,
        name: "Delete Product",
        slug: "delete-product",
        subtitle: "Temporary",
        description: "Temporary product",
        priceCents: 100,
        marketPriceCents: 0,
        coverUrl: "",
        tags: ["temp"],
        buyLimit: 1,
        isActive: true,
        sortOrder: 1
      })
      .expect(201);

    await request(app)
      .post(`/api/admin/products/${product.body.id}/inventory`)
      .set("Authorization", `Bearer ${token}`)
      .send({ lines: "DELETE-SECRET-1" })
      .expect(201);

    const inventory = await request(app)
      .get("/api/admin/inventory")
      .set("Authorization", `Bearer ${token}`)
      .query({ productId: product.body.id })
      .expect(200);
    expect(inventory.body[0].secret).not.toBe("DELETE-SECRET-1");
    expect(inventory.body[0].secret).toContain("****");

    const db = await getDb();
    const rawInventory = await db.get<any>("SELECT secret FROM inventory_items WHERE id = ?", [inventory.body[0].id]);
    expect(rawInventory.secret).toMatch(/^enc:v1:/);

    await request(app)
      .delete(`/api/admin/inventory/${inventory.body[0].id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    await request(app)
      .delete(`/api/admin/products/${product.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app)
      .delete(`/api/admin/categories/${category.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const coupon = await request(app)
      .post("/api/admin/coupons")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "DELETE10", type: "percent", value: 10, minAmountCents: 0, totalLimit: 3, isActive: true })
      .expect(201);
    await request(app)
      .delete(`/api/admin/coupons/${coupon.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const payment = await request(app)
      .post("/api/admin/payment-methods")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "deletepay", name: "DeletePay", icon: "credit-card", description: "Temporary payment", sortOrder: 120, isActive: true })
      .expect(201);
    await request(app)
      .delete(`/api/admin/payment-methods/${payment.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const announcement = await request(app)
      .post("/api/admin/announcements")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Delete Announcement", content: "Temporary announcement", level: "info", isActive: true })
      .expect(201);
    await request(app)
      .delete(`/api/admin/announcements/${announcement.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const pendingOrder = await request(app)
      .post("/api/orders")
      .send({
        productId: store.body.products[0].id,
        quantity: 1,
        contact: "delete-order@example.com",
        paymentMethod: "mockpay"
      })
      .expect(201);
    await request(app)
      .delete(`/api/admin/orders/${pendingOrder.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const orders = await request(app)
      .get("/api/admin/orders")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(orders.body.some((order: any) => order.id === pendingOrder.body.id)).toBe(false);
  });

  it("prevents zero-total checkout and unsafe coupon configuration", async () => {
    const app = createApp();
    const store = await request(app).get("/api/store").expect(200);
    const product = store.body.products[0];

    const login = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "ChangeMe123!" })
      .expect(200);
    const token = login.body.token;

    await request(app)
      .post("/api/admin/coupons")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "FREE100", type: "percent", value: 100, minAmountCents: 0, totalLimit: 1, isActive: true })
      .expect(400);

    const hugeCoupon = await request(app)
      .post("/api/admin/coupons")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "HUGE999", type: "fixed", value: 999999, minAmountCents: 0, totalLimit: 3, isActive: true })
      .expect(201);
    expect(hugeCoupon.body.code).toBe("HUGE999");

    const order = await request(app)
      .post("/api/orders")
      .send({
        productId: product.id,
        quantity: 1,
        contact: "coupon-hardening@example.com",
        couponCode: "HUGE999",
        paymentMethod: "mockpay"
      })
      .expect(201);
    expect(order.body.totalCents).toBe(1);

    await request(app)
      .post("/api/admin/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        categoryId: store.body.categories[0].id,
        name: "Free Product",
        slug: "free-product",
        subtitle: "Unsafe",
        description: "Unsafe product",
        priceCents: 0,
        marketPriceCents: 0,
        coverUrl: "",
        tags: ["temp"],
        buyLimit: 1,
        isActive: true,
        sortOrder: 1
      })
      .expect(400);
  });

  it("encrypts legacy plaintext inventory during startup migration", async () => {
    const app = createApp();
    const store = await request(app).get("/api/store").expect(200);
    const db = await getDb();
    await db.run(
      "INSERT INTO inventory_items (id, product_id, secret, status, created_at) VALUES (?, ?, ?, 'available', ?)",
      ["legacy_plain_secret", store.body.products[0].id, "LEGACY-PLAIN-SECRET", new Date().toISOString()]
    );
    await closeDb();

    const restarted = createApp();
    await request(restarted).get("/api/store").expect(200);
    const restartedDb = await getDb();
    const rawInventory = await restartedDb.get<any>("SELECT secret FROM inventory_items WHERE id = ?", ["legacy_plain_secret"]);
    expect(rawInventory.secret).toMatch(/^enc:v1:/);
    expect(rawInventory.secret).not.toContain("LEGACY-PLAIN-SECRET");
  });

  it("supports customer accounts while keeping guest contact lookup", async () => {
    const app = createApp();
    const store = await request(app).get("/api/store").expect(200);
    const product = store.body.products[0];

    const registered = await request(app)
      .post("/api/auth/register")
      .send({ email: "member@example.com", password: "secret123", name: "Member" })
      .expect(201);

    const memberOrder = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${registered.body.token}`)
      .send({
        productId: product.id,
        quantity: 1,
        contact: "member@example.com",
        paymentMethod: "mockpay"
      })
      .expect(201);

    await request(app)
      .post(`/api/payments/mock/${memberOrder.body.orderNo}/confirm`)
      .send({ paymentToken: memberOrder.body.paymentToken })
      .expect(200);

    const accountOrders = await request(app)
      .get("/api/account/orders")
      .set("Authorization", `Bearer ${registered.body.token}`)
      .expect(200);
    expect(accountOrders.body).toHaveLength(1);
    expect(accountOrders.body[0].userId).toBe(registered.body.user.id);

    const guestOrder = await request(app)
      .post("/api/orders")
      .send({
        productId: product.id,
        quantity: 1,
        contact: "guest-contact@example.com",
        paymentMethod: "mockpay"
      })
      .expect(201);
    await request(app)
      .post(`/api/payments/mock/${guestOrder.body.orderNo}/confirm`)
      .send({ paymentToken: guestOrder.body.paymentToken })
      .expect(200);

    const guestLookup = await request(app)
      .get("/api/guest/orders")
      .query({ contact: "guest-contact@example.com" })
      .expect(200);
    expect(guestLookup.body).toHaveLength(1);
    expect(guestLookup.body[0].orderNo).toBe(guestOrder.body.orderNo);
    expect(guestLookup.body[0].deliveredPayload[0].secret).toContain("****");

    const guestDetail = await request(app)
      .get(`/api/orders/${guestOrder.body.orderNo}`)
      .query({ contact: "guest-contact@example.com" })
      .expect(200);
    expect(guestDetail.body.deliveredPayload[0].secret).toContain("KEY-");
  });
});
