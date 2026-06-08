import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";
import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { config, getDatabasePath } from "./config";
import { encryptSecret, isEncryptedSecret } from "./security";

export type DbDialect = "sqlite" | "mysql";
export type SqlParams = Array<string | number | boolean | null | undefined>;

export interface DbClient {
  dialect: DbDialect;
  all<T = any>(sql: string, params?: SqlParams): Promise<T[]>;
  get<T = any>(sql: string, params?: SqlParams): Promise<T | undefined>;
  run(sql: string, params?: SqlParams): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction<T>(handler: (db: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let dbPromise: Promise<DbClient> | null = null;
const id = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export function nowIso(date = new Date()) {
  return date.toISOString();
}

export function addMinutesIso(minutes: number, date = new Date()) {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

export async function getDb() {
  if (!dbPromise) dbPromise = createDb();
  return dbPromise;
}

export async function closeDb() {
  if (!dbPromise) return;
  const db = await dbPromise;
  await db.close();
  dbPromise = null;
}

async function createDb(): Promise<DbClient> {
  const db = config.databaseClient === "mysql" ? await createMysqlDb() : createSqliteDb();
  await migrate(db);
  await seed(db);
  return db;
}

function normalizeParams(params: SqlParams = []) {
  return params.map((value) => value === undefined ? null : value);
}

class SqliteDb implements DbClient {
  readonly dialect = "sqlite" as const;

  constructor(private readonly database: Database.Database) {}

  async all<T = any>(sql: string, params: SqlParams = []) {
    return this.database.prepare(sql).all(...normalizeParams(params)) as T[];
  }

  async get<T = any>(sql: string, params: SqlParams = []) {
    return this.database.prepare(sql).get(...normalizeParams(params)) as T | undefined;
  }

  async run(sql: string, params: SqlParams = []) {
    this.database.prepare(sql).run(...normalizeParams(params));
  }

  async exec(sql: string) {
    this.database.exec(sql);
  }

  async transaction<T>(handler: (db: DbClient) => Promise<T>) {
    this.database.prepare("BEGIN").run();
    try {
      const result = await handler(this);
      this.database.prepare("COMMIT").run();
      return result;
    } catch (error) {
      this.database.prepare("ROLLBACK").run();
      throw error;
    }
  }

  async close() {
    this.database.close();
  }
}

class MysqlDb implements DbClient {
  readonly dialect = "mysql" as const;

  constructor(private readonly pool: Pool) {}

  async all<T = any>(sql: string, params: SqlParams = []) {
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, normalizeParams(params));
    return rows as T[];
  }

  async get<T = any>(sql: string, params: SqlParams = []) {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: SqlParams = []) {
    await this.pool.query<ResultSetHeader>(sql, normalizeParams(params));
  }

  async exec(sql: string) {
    for (const statement of splitSqlStatements(sql)) {
      await this.run(statement);
    }
  }

  async transaction<T>(handler: (db: DbClient) => Promise<T>) {
    const connection = await this.pool.getConnection();
    const tx = new MysqlConnectionDb(connection);
    try {
      await connection.beginTransaction();
      const result = await handler(tx);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class MysqlConnectionDb implements DbClient {
  readonly dialect = "mysql" as const;

  constructor(private readonly connection: PoolConnection) {}

  async all<T = any>(sql: string, params: SqlParams = []) {
    const [rows] = await this.connection.query<RowDataPacket[]>(sql, normalizeParams(params));
    return rows as T[];
  }

  async get<T = any>(sql: string, params: SqlParams = []) {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: SqlParams = []) {
    await this.connection.query<ResultSetHeader>(sql, normalizeParams(params));
  }

  async exec(sql: string) {
    for (const statement of splitSqlStatements(sql)) {
      await this.run(statement);
    }
  }

  async transaction<T>(handler: (db: DbClient) => Promise<T>): Promise<T> {
    return handler(this);
  }

  async close() {
    this.connection.release();
  }
}

function splitSqlStatements(sql: string) {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function createSqliteDb() {
  const databasePath = getDatabasePath();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  return new SqliteDb(database);
}

async function createMysqlDb() {
  const pool = config.mysql.uri
    ? mysql.createPool({
        uri: config.mysql.uri,
        waitForConnections: true,
        connectionLimit: config.mysql.connectionLimit,
        charset: "utf8mb4"
      })
    : mysql.createPool({
        host: config.mysql.host,
        port: config.mysql.port,
        user: config.mysql.user,
        password: config.mysql.password,
        database: config.mysql.database,
        waitForConnections: true,
        connectionLimit: config.mysql.connectionLimit,
        charset: "utf8mb4"
      });
  return new MysqlDb(pool);
}

async function migrate(db: DbClient) {
  if (db.dialect === "mysql") {
    await migrateMysql(db);
  } else {
    await migrateSqlite(db);
  }
  await encryptExistingSecrets(db);
}

async function migrateSqlite(db: DbClient) {
  await db.exec(`
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
      payment_token_hash TEXT,
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

  await ensureColumn(db, "orders", "user_id", "TEXT");
  await ensureColumn(db, "orders", "payment_token_hash", "TEXT");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);");
}

async function migrateMysql(db: DbClient) {
  const tableOptions = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
  const statements = [
    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS admins (
      id VARCHAR(32) PRIMARY KEY,
      username VARCHAR(120) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(40) NOT NULL DEFAULT 'owner',
      created_at VARCHAR(30) NOT NULL
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS customers (
      id VARCHAR(32) PRIMARY KEY,
      email VARCHAR(190) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL DEFAULT '',
      password_hash VARCHAR(255) NOT NULL,
      created_at VARCHAR(30) NOT NULL
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS categories (
      id VARCHAR(32) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(160) NOT NULL UNIQUE,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(32) PRIMARY KEY,
      category_id VARCHAR(32) NOT NULL,
      name VARCHAR(190) NOT NULL,
      slug VARCHAR(190) NOT NULL UNIQUE,
      subtitle VARCHAR(500) NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      price_cents INT NOT NULL,
      market_price_cents INT NOT NULL DEFAULT 0,
      cover_url VARCHAR(1000) NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL,
      delivery_type VARCHAR(30) NOT NULL DEFAULT 'card',
      buy_limit INT NOT NULL DEFAULT 1,
      require_contact TINYINT(1) NOT NULL DEFAULT 1,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at VARCHAR(30) NOT NULL,
      updated_at VARCHAR(30) NOT NULL,
      CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id)
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS inventory_items (
      id VARCHAR(32) PRIMARY KEY,
      product_id VARCHAR(32) NOT NULL,
      secret TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'available',
      order_id VARCHAR(32),
      reserved_until VARCHAR(30),
      created_at VARCHAR(30) NOT NULL,
      delivered_at VARCHAR(30),
      INDEX idx_inventory_product_status (product_id, status, reserved_until),
      INDEX idx_inventory_order_id (order_id),
      CONSTRAINT fk_inventory_product FOREIGN KEY (product_id) REFERENCES products(id)
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS coupons (
      id VARCHAR(32) PRIMARY KEY,
      code VARCHAR(80) NOT NULL UNIQUE,
      type VARCHAR(30) NOT NULL,
      value INT NOT NULL,
      min_amount_cents INT NOT NULL DEFAULT 0,
      total_limit INT NOT NULL DEFAULT 0,
      used_count INT NOT NULL DEFAULT 0,
      starts_at VARCHAR(30),
      ends_at VARCHAR(30),
      is_active TINYINT(1) NOT NULL DEFAULT 1
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS payment_methods (
      id VARCHAR(32) PRIMARY KEY,
      code VARCHAR(80) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL,
      icon VARCHAR(80) NOT NULL DEFAULT 'credit-card',
      description VARCHAR(1000) NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(32) PRIMARY KEY,
      order_no VARCHAR(80) NOT NULL UNIQUE,
      user_id VARCHAR(32),
      product_id VARCHAR(32) NOT NULL,
      quantity INT NOT NULL,
      unit_price_cents INT NOT NULL,
      discount_cents INT NOT NULL DEFAULT 0,
      total_cents INT NOT NULL,
      contact VARCHAR(190) NOT NULL,
      buyer_note VARCHAR(1000) NOT NULL DEFAULT '',
      payment_method VARCHAR(80) NOT NULL DEFAULT 'mockpay',
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      coupon_code VARCHAR(80),
      delivered_payload LONGTEXT NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      expires_at VARCHAR(30) NOT NULL,
      paid_at VARCHAR(30),
      delivered_at VARCHAR(30),
      payment_token_hash VARCHAR(128),
      client_ip VARCHAR(80),
      INDEX idx_orders_order_no (order_no),
      INDEX idx_orders_contact (contact),
      INDEX idx_orders_status (status),
      INDEX idx_orders_user_id (user_id),
      CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES products(id)
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id VARCHAR(32) PRIMARY KEY,
      title VARCHAR(190) NOT NULL,
      content TEXT NOT NULL,
      level VARCHAR(30) NOT NULL DEFAULT 'info',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at VARCHAR(30) NOT NULL
    ) ${tableOptions}`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(32) PRIMARY KEY,
      actor VARCHAR(80) NOT NULL,
      action VARCHAR(120) NOT NULL,
      detail TEXT NOT NULL,
      created_at VARCHAR(30) NOT NULL
    ) ${tableOptions}`
  ];

  for (const statement of statements) await db.run(statement);
  await ensureColumn(db, "orders", "user_id", "VARCHAR(32)");
  await ensureColumn(db, "orders", "payment_token_hash", "VARCHAR(128)");
}

async function ensureColumn(db: DbClient, table: string, column: string, definition: string) {
  if (db.dialect === "mysql") {
    const existing = await db.get<{ name: string }>(`
      SELECT COLUMN_NAME AS name
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `, [table, column]);
    if (!existing) await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return;
  }

  const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function encryptExistingSecrets(db: DbClient) {
  const inventoryRows = await db.all<{ id: string; secret: string }>(`
    SELECT id, secret FROM inventory_items
    WHERE secret NOT LIKE 'enc:v1:%'
  `);
  for (const row of inventoryRows) {
    await db.run("UPDATE inventory_items SET secret = ? WHERE id = ?", [encryptSecret(row.secret), row.id]);
  }

  const orderRows = await db.all<{ id: string; delivered_payload: string }>(`
    SELECT id, delivered_payload FROM orders
    WHERE delivered_payload IS NOT NULL AND delivered_payload != '[]'
  `);
  for (const row of orderRows) {
    let changed = false;
    let payload: Array<{ id: string; secret: string; deliveredAt: string }>;
    try {
      payload = JSON.parse(row.delivered_payload);
    } catch {
      continue;
    }
    const encryptedPayload = payload.map((item) => {
      if (!item?.secret || isEncryptedSecret(item.secret)) return item;
      changed = true;
      return { ...item, secret: encryptSecret(item.secret) };
    });
    if (changed) {
      await db.run("UPDATE orders SET delivered_payload = ? WHERE id = ?", [JSON.stringify(encryptedPayload), row.id]);
    }
  }
}

async function seed(db: DbClient) {
  await ensureDefaultRows(db);
  const seeded = await db.get("SELECT value FROM settings WHERE `key` = ?", ["seeded_at"]);
  if (seeded) return;

  const createdAt = nowIso();
  const categories = [
    { id: id(), name: "软件授权", slug: "software", sortOrder: 10 },
    { id: id(), name: "会员账号", slug: "accounts", sortOrder: 20 },
    { id: id(), name: "学习资料", slug: "courses", sortOrder: 30 }
  ];
  const products = [
    {
      id: id(),
      categoryId: categories[0].id,
      name: "Pro 工具箱月卡",
      slug: "pro-toolbox-monthly",
      subtitle: "即买即用，支持订单页查看与二次复制",
      description: "适合个人用户的轻量授权卡，支付完成后系统自动交付唯一授权码。",
      priceCents: 2990,
      marketPriceCents: 3990,
      coverUrl: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=900&q=80",
      tagsJson: JSON.stringify(["自动发货", "库存预占", "售后可查"]),
      buyLimit: 3,
      sortOrder: 10
    },
    {
      id: id(),
      categoryId: categories[1].id,
      name: "云端协作会员 30 天",
      slug: "cloud-collab-30d",
      subtitle: "账号信息加密存储，发货后仅订单可见",
      description: "包含账号、初始密码和安全提示。建议领取后立即修改密码。",
      priceCents: 1590,
      marketPriceCents: 1990,
      coverUrl: "https://images.unsplash.com/photo-1551434678-e076c223a692?auto=format&fit=crop&w=900&q=80",
      tagsJson: JSON.stringify(["会员账号", "自动交付", "低库存提醒"]),
      buyLimit: 2,
      sortOrder: 20
    },
    {
      id: id(),
      categoryId: categories[2].id,
      name: "前端进阶资料包",
      slug: "frontend-kit",
      subtitle: "下载链接 + 提取码，付款后即时显示",
      description: "资料包包含课程链接、提取码和版本说明，适合前端工程师系统复习。",
      priceCents: 990,
      marketPriceCents: 1490,
      coverUrl: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80",
      tagsJson: JSON.stringify(["资料链接", "可复制", "长期有效"]),
      buyLimit: 5,
      sortOrder: 30
    }
  ];

  await db.transaction(async (tx) => {
    const settings = [
      ["store_name", "星河自动发货"],
      ["store_slogan", "稳定库存、即时交付、订单可追踪"],
      ["support_email", "support@example.com"],
      ["payment_notice", "订单提交后进入收银台，演示站使用 MockPay 完成支付与自动发货。"],
      ["checkout_tips", "库存会在下单后锁定 15 分钟，请填写可用于售后查询的联系方式。"],
      ["seeded_at", createdAt]
    ];
    for (const [key, value] of settings) {
      await tx.run("INSERT INTO settings (`key`, value) VALUES (?, ?)", [key, value]);
    }

    for (const category of categories) {
      await tx.run(
        "INSERT INTO categories (id, name, slug, sort_order, is_active) VALUES (?, ?, ?, ?, 1)",
        [category.id, category.name, category.slug, category.sortOrder]
      );
    }

    for (const product of products) {
      await tx.run(`
        INSERT INTO products (
          id, category_id, name, slug, subtitle, description, price_cents,
          market_price_cents, cover_url, tags_json, delivery_type, buy_limit,
          require_contact, is_active, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'card', ?, 1, 1, ?, ?, ?)
      `, [
        product.id,
        product.categoryId,
        product.name,
        product.slug,
        product.subtitle,
        product.description,
        product.priceCents,
        product.marketPriceCents,
        product.coverUrl,
        product.tagsJson,
        product.buyLimit,
        product.sortOrder,
        createdAt,
        createdAt
      ]);
    }

    for (const [productIndex, product] of products.entries()) {
      for (let index = 1; index <= 18; index += 1) {
        const secret = [
          `${product.slug.toUpperCase()}-${String(index).padStart(3, "0")}`,
          `KEY-${id().toUpperCase()}`,
          productIndex === 2 ? "https://example.com/download/front-end-kit" : "请妥善保存，售出不退"
        ].join(" | ");
        await tx.run(
          "INSERT INTO inventory_items (id, product_id, secret, status, created_at) VALUES (?, ?, ?, 'available', ?)",
          [id(), product.id, encryptSecret(secret), createdAt]
        );
      }
    }

    await tx.run("INSERT INTO coupons (id, code, type, value, min_amount_cents, total_limit, used_count, is_active) VALUES (?, ?, ?, ?, ?, ?, 0, 1)", [id(), "WELCOME10", "percent", 10, 1000, 200]);
    await tx.run("INSERT INTO coupons (id, code, type, value, min_amount_cents, total_limit, used_count, is_active) VALUES (?, ?, ?, ?, ?, ?, 0, 1)", [id(), "SAVE5", "fixed", 500, 1500, 100]);
    await tx.run("INSERT INTO announcements (id, title, content, level, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)", [id(), "库存锁定机制已启用", "提交订单后会为你保留库存 15 分钟，完成支付后自动发货。", "success", createdAt]);
    await tx.run("INSERT INTO announcements (id, title, content, level, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)", [id(), "演示支付说明", "当前项目内置 MockPay，适合本地开发和业务流程验证。", "info", createdAt]);
    await tx.run("INSERT INTO admins (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'owner', ?)", [id(), config.adminUser, bcrypt.hashSync(config.adminPassword, 12), createdAt]);
  });
}

async function ensureDefaultRows(db: DbClient) {
  const methodCount = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM payment_methods");
  if (!methodCount?.count) {
    const methods = [
      ["mockpay", "MockPay", "credit-card", "本地演示支付，点击确认后立即触发发货事务。", 10, 1],
      ["alipay", "支付宝", "qr-code", "预留真实支付通道，可在回调中复用自动发货事务。", 20, 1],
      ["wechat", "微信支付", "message-circle", "预留移动端扫码支付通道。", 30, 1]
    ];
    for (const [code, name, icon, description, sortOrder, isActive] of methods) {
      await db.run(
        "INSERT INTO payment_methods (id, code, name, icon, description, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id(), code, name, icon, description, sortOrder, isActive]
      );
    }
  }

  const defaults = [
    ["store_theme", "commerce"],
    ["stock_warning", "3"],
    ["support_hours", "09:00-22:00"]
  ];
  for (const [key, value] of defaults) {
    const existing = await db.get("SELECT value FROM settings WHERE `key` = ?", [key]);
    if (!existing) await db.run("INSERT INTO settings (`key`, value) VALUES (?, ?)", [key, value]);
  }
}
