import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";
import { config, getDatabasePath } from "./config";

export type Db = Database.Database;

let db: Db | null = null;
const id = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export function nowIso(date = new Date()) {
  return date.toISOString();
}

export function addMinutesIso(minutes: number, date = new Date()) {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

export function getDb() {
  if (!db) {
    const databasePath = getDatabasePath();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
    seed(db);
  }
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

export function migrate(database: Db) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES categories(id),
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      subtitle TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL,
      market_price_cents INTEGER NOT NULL DEFAULT 0,
      cover_url TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      delivery_type TEXT NOT NULL DEFAULT 'card',
      buy_limit INTEGER NOT NULL DEFAULT 1,
      require_contact INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      secret TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      order_id TEXT,
      reserved_until TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_product_status
      ON inventory_items(product_id, status, reserved_until);

    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      value INTEGER NOT NULL,
      min_amount_cents INTEGER NOT NULL DEFAULT 0,
      total_limit INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      starts_at TEXT,
      ends_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS payment_methods (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'credit-card',
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      user_id TEXT,
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL,
      contact TEXT NOT NULL,
      buyer_note TEXT NOT NULL DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT 'mockpay',
      status TEXT NOT NULL DEFAULT 'pending',
      coupon_code TEXT,
      delivered_payload TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      paid_at TEXT,
      delivered_at TEXT,
      client_ip TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
    CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(contact);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  ensureColumn(database, "orders", "user_id", "TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);");
}

function ensureColumn(database: Db, table: string, column: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function seed(database: Db) {
  ensureDefaultRows(database);
  const seeded = database.prepare("SELECT value FROM settings WHERE key = ?").get("seeded_at");
  if (seeded) return;

  const createdAt = nowIso();
  const insertSetting = database.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  const insertCategory = database.prepare(`
    INSERT INTO categories (id, name, slug, sort_order, is_active)
    VALUES (@id, @name, @slug, @sortOrder, 1)
  `);
  const insertProduct = database.prepare(`
    INSERT INTO products (
      id, category_id, name, slug, subtitle, description, price_cents,
      market_price_cents, cover_url, tags_json, delivery_type, buy_limit,
      require_contact, is_active, sort_order, created_at, updated_at
    ) VALUES (
      @id, @categoryId, @name, @slug, @subtitle, @description, @priceCents,
      @marketPriceCents, @coverUrl, @tagsJson, 'card', @buyLimit,
      1, 1, @sortOrder, @createdAt, @createdAt
    )
  `);
  const insertInventory = database.prepare(`
    INSERT INTO inventory_items (id, product_id, secret, status, created_at)
    VALUES (?, ?, ?, 'available', ?)
  `);
  const insertCoupon = database.prepare(`
    INSERT INTO coupons (id, code, type, value, min_amount_cents, total_limit, used_count, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1)
  `);
  const insertAnnouncement = database.prepare(`
    INSERT INTO announcements (id, title, content, level, is_active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `);

  const seedTx = database.transaction(() => {
    insertSetting.run("store_name", "星河自动发货");
    insertSetting.run("store_slogan", "稳定库存、即时交付、订单可追踪");
    insertSetting.run("support_email", "support@example.com");
    insertSetting.run("payment_notice", "订单提交后进入收银台，演示站使用 MockPay 完成支付与自动发货。");
    insertSetting.run("checkout_tips", "库存会在下单后锁定 15 分钟，请填写可用于售后查询的联系方式。");
    insertSetting.run("seeded_at", createdAt);

    const software = { id: id(), name: "软件授权", slug: "software", sortOrder: 10 };
    const accounts = { id: id(), name: "会员账号", slug: "accounts", sortOrder: 20 };
    const materials = { id: id(), name: "学习资料", slug: "courses", sortOrder: 30 };
    [software, accounts, materials].forEach((category) => insertCategory.run(category));

    const products = [
      {
        id: id(),
        categoryId: software.id,
        name: "Pro 工具箱月卡",
        slug: "pro-toolbox-monthly",
        subtitle: "即买即用，支持订单页查看与二次复制",
        description: "适合个人用户的轻量授权卡，支付完成后系统自动交付唯一授权码。",
        priceCents: 2990,
        marketPriceCents: 3990,
        coverUrl: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=900&q=80",
        tagsJson: JSON.stringify(["自动发货", "库存预占", "售后可查"]),
        buyLimit: 3,
        sortOrder: 10,
        createdAt
      },
      {
        id: id(),
        categoryId: accounts.id,
        name: "云端协作会员 30 天",
        slug: "cloud-collab-30d",
        subtitle: "账号信息加密存储，发货后仅订单可见",
        description: "包含账号、初始密码和安全提示。建议领取后立即修改密码。",
        priceCents: 1590,
        marketPriceCents: 1990,
        coverUrl: "https://images.unsplash.com/photo-1551434678-e076c223a692?auto=format&fit=crop&w=900&q=80",
        tagsJson: JSON.stringify(["会员账号", "自动交付", "低库存提醒"]),
        buyLimit: 2,
        sortOrder: 20,
        createdAt
      },
      {
        id: id(),
        categoryId: materials.id,
        name: "前端进阶资料包",
        slug: "frontend-kit",
        subtitle: "下载链接 + 提取码，付款后即时显示",
        description: "资料包包含课程链接、提取码和版本说明，适合前端工程师系统复习。",
        priceCents: 990,
        marketPriceCents: 1490,
        coverUrl: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80",
        tagsJson: JSON.stringify(["资料链接", "可复制", "长期有效"]),
        buyLimit: 5,
        sortOrder: 30,
        createdAt
      }
    ];

    products.forEach((product) => insertProduct.run(product));
    products.forEach((product, productIndex) => {
      for (let index = 1; index <= 18; index += 1) {
        const secret = [
          `${product.slug.toUpperCase()}-${String(index).padStart(3, "0")}`,
          `KEY-${id().toUpperCase()}`,
          productIndex === 2 ? "https://example.com/download/front-end-kit" : "请妥善保存，售出不退"
        ].join(" | ");
        insertInventory.run(id(), product.id, secret, createdAt);
      }
    });

    insertCoupon.run(id(), "WELCOME10", "percent", 10, 1000, 200);
    insertCoupon.run(id(), "SAVE5", "fixed", 500, 1500, 100);
    insertAnnouncement.run(id(), "库存锁定机制已启用", "提交订单后会为你保留库存 15 分钟，完成支付后自动发货。", "success", createdAt);
    insertAnnouncement.run(id(), "演示支付说明", "当前项目内置 MockPay，适合本地开发和业务流程验证。", "info", createdAt);

    database.prepare(`
      INSERT INTO admins (id, username, password_hash, role, created_at)
      VALUES (?, ?, ?, 'owner', ?)
    `).run(id(), config.adminUser, bcrypt.hashSync(config.adminPassword, 12), createdAt);
  });

  seedTx();
}

function ensureDefaultRows(database: Db) {
  const methodCount = database.prepare("SELECT COUNT(*) AS count FROM payment_methods").get() as { count: number };
  if (methodCount.count === 0) {
    const insertMethod = database.prepare(`
      INSERT INTO payment_methods (id, code, name, icon, description, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertMethod.run(id(), "mockpay", "MockPay", "credit-card", "本地演示支付，点击确认后立即触发发货事务。", 10, 1);
    insertMethod.run(id(), "alipay", "支付宝", "qr-code", "预留真实支付通道，可在回调中复用自动发货事务。", 20, 1);
    insertMethod.run(id(), "wechat", "微信支付", "message-circle", "预留移动端扫码支付通道。", 30, 1);
  }

  const defaults = [
    ["store_theme", "commerce"],
    ["stock_warning", "3"],
    ["support_hours", "09:00-22:00"]
  ];
  const upsert = database.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  defaults.forEach(([key, value]) => upsert.run(key, value));
}
