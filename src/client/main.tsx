import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BadgeCheck,
  Boxes,
  Check,
  ChevronLeft,
  Clipboard,
  CreditCard,
  Eye,
  FileText,
  Gauge,
  Gift,
  Layers3,
  LogIn,
  Megaphone,
  MessageCircle,
  Package,
  Pencil,
  Plus,
  QrCode,
  RefreshCcw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Tags,
  Trash2,
  Truck,
  X
} from "lucide-react";
import type {
  AdminStats,
  Announcement,
  Category,
  Coupon,
  Customer,
  DeliveredItem,
  InventoryItem,
  Order,
  PaymentMethod,
  Product,
  StorefrontPayload
} from "../shared/types";
import "./styles.css";

type View = "shop" | "admin";
type AdminTab = "dashboard" | "categories" | "products" | "inventory" | "orders" | "payments" | "coupons" | "announcements" | "settings";

interface AdminUser {
  id: string;
  username: string;
  role: string;
}

interface ProductForm {
  id?: string;
  categoryId: string;
  name: string;
  slug: string;
  subtitle: string;
  description: string;
  priceCents: number;
  marketPriceCents: number;
  coverUrl: string;
  tags: string;
  buyLimit: number;
  isActive: boolean;
  sortOrder: number;
}

const emptyProductForm: ProductForm = {
  categoryId: "",
  name: "",
  slug: "",
  subtitle: "",
  description: "",
  priceCents: 990,
  marketPriceCents: 0,
  coverUrl: "",
  tags: "自动发货,库存锁定,售后可查",
  buyLimit: 1,
  isActive: true,
  sortOrder: 0
};

const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
const statusText: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  delivered: "已发货",
  closed: "已关闭",
  refunded: "已退款",
  available: "可售",
  reserved: "锁定中",
  disabled: "禁用"
};

const paymentIcons: Record<string, React.ReactNode> = {
  "credit-card": <CreditCard size={18} />,
  "qr-code": <QrCode size={18} />,
  "message-circle": <MessageCircle size={18} />
};

const fallbackCover = "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80";

async function api<T>(path: string, options: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);

  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "请求失败，请稍后再试");
  return payload as T;
}

function App() {
  const [view, setView] = useState<View>(() => (window.location.hash === "#admin" ? "admin" : "shop"));

  useEffect(() => {
    const onHash = () => setView(window.location.hash === "#admin" ? "admin" : "shop");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return view === "admin"
    ? <AdminPanel onBack={() => { window.location.hash = ""; setView("shop"); }} />
    : <ShopView onAdmin={() => { window.location.hash = "admin"; setView("admin"); }} />;
}

function ShopView({ onAdmin }: { onAdmin: () => void }) {
  const [store, setStore] = useState<StorefrontPayload | null>(null);
  const [page, setPage] = useState<"home" | "checkout" | "auth" | "orders">("home");
  const [activeCategory, setActiveCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [checkoutProduct, setCheckoutProduct] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [contact, setContact] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [buyerNote, setBuyerNote] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("mockpay");
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  const [lookupContact, setLookupContact] = useState("");
  const [guestOrders, setGuestOrders] = useState<Order[]>([]);
  const [accountOrders, setAccountOrders] = useState<Order[]>([]);
  const [customerToken, setCustomerToken] = useState(() => localStorage.getItem("ddp_customer_token") || "");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authForm, setAuthForm] = useState({ email: "", password: "", name: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function loadStore() {
    setError("");
    setLoading(true);
    try {
      const payload = await api<StorefrontPayload>("/api/store");
      setStore(payload);
      if (!paymentMethod && payload.paymentMethods[0]) setPaymentMethod(payload.paymentMethods[0].code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "店铺加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStore();
  }, []);

  useEffect(() => {
    if (!customerToken) return;
    api<Customer>("/api/auth/me", { token: customerToken })
      .then((payload) => {
        setCustomer(payload);
        setContact((current) => current || payload.email);
      })
      .catch(() => {
        localStorage.removeItem("ddp_customer_token");
        setCustomerToken("");
        setCustomer(null);
      });
  }, [customerToken]);

  const filteredProducts = useMemo(() => {
    if (!store) return [];
    const keyword = query.trim().toLowerCase();
    return store.products.filter((product) => {
      const byCategory = activeCategory === "all" || product.categoryId === activeCategory;
      const text = [product.name, product.subtitle, product.description, product.categoryName, product.tags.join(" ")].join(" ").toLowerCase();
      return byCategory && (!keyword || text.includes(keyword));
    });
  }, [store, activeCategory, query]);

  const categoryStats = useMemo(() => {
    const products = store?.products || [];
    return new Map((store?.categories || []).map((category) => [
      category.id,
      {
        count: products.filter((product) => product.categoryId === category.id).length,
        stock: products.filter((product) => product.categoryId === category.id).reduce((sum, product) => sum + product.stock, 0)
      }
    ]));
  }, [store]);

  const subtotal = checkoutProduct ? checkoutProduct.priceCents * quantity : 0;
  const maxQuantity = checkoutProduct ? Math.max(1, Math.min(checkoutProduct.stock, checkoutProduct.buyLimit)) : 1;
  const currentPayment = store?.paymentMethods.find((method) => method.code === paymentMethod) || store?.paymentMethods[0];

  function openCheckout(product: Product) {
    setCheckoutProduct(product);
    setQuantity(product.stock > 0 ? 1 : 0);
    setContact(customer?.email || contact);
    setCouponCode("");
    setActiveOrder(null);
    setError("");
    setMessage("");
    setPage("checkout");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function returnHome() {
    setError("");
    setMessage("");
    setActiveOrder(null);
    setCheckoutProduct(null);
    setPage("home");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitOrder(event: FormEvent) {
    event.preventDefault();
    if (!checkoutProduct) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const order = await api<Order>("/api/orders", {
        method: "POST",
        token: customerToken || undefined,
        body: JSON.stringify({
          productId: checkoutProduct.id,
          quantity,
          contact,
          buyerNote,
          couponCode: couponCode.trim() || undefined,
          paymentMethod: currentPayment?.code || "mockpay"
        })
      });
      setActiveOrder(order);
      setMessage("订单已创建，请在收银台完成支付。");
      await loadStore();
    } catch (err) {
      setError(err instanceof Error ? err.message : "下单失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirmPayment() {
    if (!activeOrder) return;
    setBusy(true);
    setError("");
    try {
      const delivered = await api<Order>(`/api/payments/mock/${activeOrder.orderNo}/confirm`, {
        method: "POST",
        body: JSON.stringify({ paymentToken: activeOrder.paymentToken })
      });
      setActiveOrder(delivered);
      setMessage("支付成功，系统已自动发货。");
      if (customerToken) void loadAccountOrders();
      await loadStore();
    } catch (err) {
      setError(err instanceof Error ? err.message : "支付确认失败");
    } finally {
      setBusy(false);
    }
  }

  async function lookupGuestOrders(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const orders = await api<Order[]>(`/api/guest/orders?contact=${encodeURIComponent(lookupContact.trim())}`);
      setGuestOrders(orders);
      setMessage(orders.length ? `找到 ${orders.length} 个订单` : "没有找到相关订单");
    } catch (err) {
      setGuestOrders([]);
      setError(err instanceof Error ? err.message : "订单查询失败");
    } finally {
      setBusy(false);
    }
  }

  async function revealGuestOrder(order: Order) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const detail = await api<Order>(`/api/orders/${order.orderNo}?contact=${encodeURIComponent(order.contact)}`);
      setGuestOrders((orders) => orders.map((item) => item.id === detail.id ? detail : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : "订单详情加载失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (authMode === "login") {
        try {
          const adminResult = await api<{ token: string; user: AdminUser }>("/api/admin/login", {
            method: "POST",
            body: JSON.stringify({ username: authForm.email.trim(), password: authForm.password })
          });
          localStorage.setItem("ddp_admin_token", adminResult.token);
          localStorage.removeItem("ddp_customer_token");
          onAdmin();
          return;
        } catch {
          // Continue with customer login when the credentials are not an admin account.
        }
      }
      const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
      const result = await api<{ token: string; user: Customer }>(path, {
        method: "POST",
        body: JSON.stringify(authForm)
      });
      localStorage.setItem("ddp_customer_token", result.token);
      setCustomerToken(result.token);
      setCustomer(result.user);
      setContact(result.user.email);
      setMessage(authMode === "register" ? "注册成功，已登录。" : "登录成功。");
      setPage("home");
      window.scrollTo({ top: 0, behavior: "smooth" });
      await loadAccountOrders(result.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  async function loadAccountOrders(token = customerToken) {
    if (!token) return;
    const orders = await api<Order[]>("/api/account/orders", { token });
    setAccountOrders(orders);
  }

  function logoutCustomer() {
    localStorage.removeItem("ddp_customer_token");
    setCustomerToken("");
    setCustomer(null);
    setAccountOrders([]);
    setMessage("已退出登录。");
  }

  function openOrdersPage() {
    setError("");
    setMessage("");
    setPage("orders");
    if (customerToken) void loadAccountOrders();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className={page === "checkout" ? "buyer-shell checkout-shell" : "buyer-shell"}>
      <header className="buyer-topbar">
        <button className="brand store-badge" type="button" onClick={returnHome} title="返回首页">
          <Store size={24} />
          <span>{store?.settings.store_name || "自动发货商城"}</span>
        </button>
        <nav className="buyer-nav">
          <button className={page === "home" ? "active" : ""} type="button" onClick={returnHome}>
            <Store size={18} />
            首页
          </button>
          <button type="button" onClick={openOrdersPage}>
            <FileText size={18} />
            {customer ? "我的订单" : "游客查单"}
          </button>
          <button className={page === "auth" ? "active" : ""} type="button" onClick={() => setPage("auth")}>
            <LogIn size={18} />
            {customer ? customer.name : "登录/注册"}
          </button>
        </nav>
      </header>

      {error && <div className="alert error"><X size={18} />{error}</div>}
      {message && <div className="alert success"><Check size={18} />{message}</div>}

      {page === "home" && (
        <HomePage
          store={store}
          loading={loading}
          products={filteredProducts}
          query={query}
          setQuery={setQuery}
          activeCategory={activeCategory}
          setActiveCategory={setActiveCategory}
          categoryStats={categoryStats}
          onBuy={openCheckout}
        />
      )}

      {page === "checkout" && checkoutProduct && (
        <PaymentPage
          product={checkoutProduct}
          customer={customer}
          quantity={quantity}
          setQuantity={setQuantity}
          maxQuantity={maxQuantity}
          contact={contact}
          setContact={setContact}
          couponCode={couponCode}
          setCouponCode={setCouponCode}
          buyerNote={buyerNote}
          setBuyerNote={setBuyerNote}
          paymentMethods={store?.paymentMethods || []}
          paymentMethod={paymentMethod}
          setPaymentMethod={setPaymentMethod}
          subtotal={subtotal}
          activeOrder={activeOrder}
          currentPayment={currentPayment}
          busy={busy}
          onBack={returnHome}
          onSubmit={submitOrder}
          onConfirm={confirmPayment}
        />
      )}

      {page === "auth" && (
        <AuthPage
          customer={customer}
          authMode={authMode}
          setAuthMode={setAuthMode}
          authForm={authForm}
          setAuthForm={setAuthForm}
          busy={busy}
          onSubmit={submitAuth}
          onLogout={logoutCustomer}
          onOrders={openOrdersPage}
        />
      )}

      {page === "orders" && (
        <OrdersPage
          customer={customer}
          accountOrders={accountOrders}
          guestOrders={guestOrders}
          lookupContact={lookupContact}
          setLookupContact={setLookupContact}
          busy={busy}
          onLookup={lookupGuestOrders}
          onLogin={() => setPage("auth")}
          onRefreshAccount={() => void loadAccountOrders()}
          onRevealGuest={revealGuestOrder}
        />
      )}
    </main>
  );
}

function HomePage({
  store,
  loading,
  products,
  query,
  setQuery,
  activeCategory,
  setActiveCategory,
  categoryStats,
  onBuy
}: {
  store: StorefrontPayload | null;
  loading: boolean;
  products: Product[];
  query: string;
  setQuery: (value: string) => void;
  activeCategory: string;
  setActiveCategory: (value: string) => void;
  categoryStats: Map<string, { count: number; stock: number }>;
  onBuy: (product: Product) => void;
}) {
  return (
    <>
      {(store?.announcements || []).length > 0 && (
        <section className="notice-strip">
          <Megaphone size={17} />
          <strong>{store?.announcements[0]?.title}</strong>
          <span>{store?.announcements[0]?.content}</span>
        </section>
      )}

      <section className="shop-filter-card">
        <div className="searchbox">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、标签、说明" />
        </div>
        <div className="category-pills" aria-label="商品分类">
          <button className={activeCategory === "all" ? "active" : ""} type="button" onClick={() => setActiveCategory("all")}>
            全部商品
            <b>{store?.products.length || 0}</b>
          </button>
          {(store?.categories || []).map((category) => {
            const stat = categoryStats.get(category.id);
            return (
              <button
                className={activeCategory === category.id ? "active" : ""}
                type="button"
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
              >
                {category.name}
                <b>{stat?.count || 0}</b>
              </button>
            );
          })}
        </div>
      </section>

      <section className="product-card-grid">
        {loading && <div className="empty-state">正在载入商品...</div>}
        {!loading && products.length === 0 && <div className="empty-state">没有匹配的商品</div>}
        {products.map((product) => (
          <article className="store-product-card" key={product.id}>
            <div className="card-cover">
              <img src={product.coverUrl || fallbackCover} alt={product.name} />
              {product.stock <= 0 && <span className="soldout-ribbon">售罄</span>}
            </div>
            <div className="card-body">
              <p>分类 · {product.categoryName}</p>
              <h2>{product.name}</h2>
              <div className="card-tags">
                <span><ShieldCheck size={14} /> 游客可购</span>
                <span><Truck size={14} /> {product.deliveryType === "card" ? "自动交付" : "人工交付"}</span>
                <span className={product.stock > 0 ? "stock-ok" : "stock-out"}>库存 {product.stock}</span>
              </div>
              <p className="card-desc">{product.subtitle || product.description}</p>
              <div className="card-footer">
                <strong>{money(product.priceCents)}</strong>
                <button className="primary-button" type="button" onClick={() => onBuy(product)} disabled={product.stock <= 0}>
                  <ShoppingCart size={17} />
                  下单
                </button>
              </div>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

function PaymentPage(props: {
  product: Product | null;
  customer: Customer | null;
  quantity: number;
  setQuantity: (quantity: number) => void;
  maxQuantity: number;
  contact: string;
  setContact: (value: string) => void;
  couponCode: string;
  setCouponCode: (value: string) => void;
  buyerNote: string;
  setBuyerNote: (value: string) => void;
  paymentMethods: PaymentMethod[];
  paymentMethod: string;
  setPaymentMethod: (value: string) => void;
  subtotal: number;
  activeOrder: Order | null;
  currentPayment?: PaymentMethod;
  busy: boolean;
  onBack: () => void;
  onSubmit: (event: FormEvent) => void;
  onConfirm: () => void;
}) {
  const product = props.product;
  if (!product) return null;
  const deliveryLabel = product.deliveryType === "card" ? "自动交付" : "人工交付";
  const productIntro = product.description || product.subtitle || "商品信息将在订单中记录，支付完成后可在订单详情查看交付内容。";

  return (
    <section className="payment-layout">
      <aside className="payment-card">
        <div className="checkout-card-top">
          <button className="ghost-button payment-back" type="button" onClick={props.onBack}>
            <ChevronLeft size={18} />
            返回商品
          </button>
          <span className="delivery-chip">
            <Truck size={15} />
            {deliveryLabel}
          </span>
        </div>
        {props.activeOrder ? (
          <div className="checkout-card-body">
            <div className="checkout-context-panel">
              <ProductCheckoutSummary product={product} productIntro={productIntro} />
              <div className="checkout-mini-grid">
                <div>
                  <strong>订单已锁定</strong>
                  <small>{props.activeOrder.orderNo}</small>
                </div>
                <div>
                  <strong>下一步</strong>
                  <small>{props.activeOrder.status === "delivered" ? "发货内容已生成，可以复制保存。" : "确认支付后会自动发货并显示内容。"}</small>
                </div>
              </div>
            </div>
            <Cashier order={props.activeOrder} payment={props.currentPayment} busy={props.busy} onConfirm={props.onConfirm} />
          </div>
        ) : (
          <div className="checkout-card-body">
            <div className="checkout-context-panel">
              <ProductCheckoutSummary product={product} productIntro={productIntro} />
              <div className="login-hint">
                {props.customer ? `已登录：${props.customer.email}，订单会自动保存到账号。` : "游客可直接购买；登录后订单会自动保存。"}
              </div>
              <div className="checkout-summary-card">
                <div>
                  <span>商品单价</span>
                  <strong>{money(product.priceCents)}</strong>
                </div>
                <div>
                  <span>购买数量</span>
                  <strong>{props.quantity}</strong>
                </div>
                <div>
                  <span>库存剩余</span>
                  <strong>{product.stock}</strong>
                </div>
              </div>
              <div className="checkout-mini-grid">
                <div>
                  <strong>交付流程</strong>
                  <small>{product.deliveryType === "card" ? "付款后自动展示发货内容，可在订单详情再次查看。" : "付款后进入处理流程，结果会同步到订单详情。"}</small>
                </div>
                <div>
                  <strong>售后凭证</strong>
                  <small>订单号和联系方式用于查单、补发和售后核验。</small>
                </div>
              </div>
            </div>
            <form className="checkout-form" onSubmit={props.onSubmit}>
              <div className="compact-fields">
                <label>
                  数量
                  <input
                    type="number"
                    min={1}
                    max={props.maxQuantity}
                    value={props.quantity}
                    onChange={(event) => props.setQuantity(Number(event.target.value))}
                    disabled={product.stock <= 0}
                  />
                </label>
                <label>
                  优惠码
                  <input value={props.couponCode} onChange={(event) => props.setCouponCode(event.target.value)} placeholder="可选，输入优惠码" />
                </label>
              </div>
              <label>
                联系方式
                <input value={props.contact} onChange={(event) => props.setContact(event.target.value)} placeholder="邮箱或手机号" required />
              </label>
              <label>
                支付方式
                <div className="payment-grid">
                  {props.paymentMethods.map((method) => (
                    <button
                      type="button"
                      className={props.paymentMethod === method.code ? "payment-option active" : "payment-option"}
                      key={method.id}
                      onClick={() => props.setPaymentMethod(method.code)}
                    >
                      {paymentIcons[method.icon] || <CreditCard size={18} />}
                      <span>{method.name}</span>
                    </button>
                  ))}
                </div>
              </label>
              <details className="optional-note">
                <summary>备注（可选）</summary>
                <textarea value={props.buyerNote} onChange={(event) => props.setBuyerNote(event.target.value)} rows={2} placeholder="可选" />
              </details>
              <div className="checkout-total">
                <span>应付金额</span>
                <strong>{money(props.subtotal)}</strong>
              </div>
              <div className="checkout-support">
                <span><ShieldCheck size={15} /> 下单锁定库存 15 分钟</span>
                <span><MessageCircle size={15} /> 联系方式用于查单和售后</span>
              </div>
              <button className="primary-button full" type="submit" disabled={props.busy || product.stock <= 0}>
                <CreditCard size={18} />
                {product.stock <= 0 ? "库存不足" : "提交订单"}
              </button>
            </form>
          </div>
        )}
      </aside>
    </section>
  );
}

function ProductCheckoutSummary({ product, productIntro }: { product: Product; productIntro: string }) {
  return (
    <div className="checkout-product-summary">
      <img src={product.coverUrl || fallbackCover} alt={product.name} />
      <div>
        <span>订单确认</span>
        <h1>{product.name}</h1>
        <p>{product.subtitle || product.categoryName}</p>
        <small>{productIntro}</small>
      </div>
    </div>
  );
}

function Cashier({ order, payment, busy, onConfirm }: {
  order: Order;
  payment?: PaymentMethod;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <section className="cashier-card">
      <div className="panel-title">
        <CreditCard size={19} />
        <h3>收银台</h3>
      </div>
      <div className="timeline">
        <span className="done">锁定库存</span>
        <span className={order.status === "delivered" ? "done" : "active"}>确认支付</span>
        <span className={order.status === "delivered" ? "done" : ""}>自动发货</span>
      </div>
      <div className="order-brief">
        <span>{order.orderNo}</span>
        <b className={`status ${order.status}`}>{statusText[order.status]}</b>
      </div>
      <div className="paybox">
        <div>
          <small>{payment?.name || order.paymentMethod}</small>
          <strong>{money(order.totalCents)}</strong>
          {order.discountCents > 0 && <span>已优惠 {money(order.discountCents)}</span>}
        </div>
        {paymentIcons[payment?.icon || "credit-card"] || <CreditCard size={28} />}
      </div>
      {order.status === "pending" && (
        <button className="success-button full" type="button" onClick={onConfirm} disabled={busy}>
          <Truck size={18} />
          演示确认支付并发货
        </button>
      )}
      {order.deliveredPayload.length > 0 && <DeliveryList order={order} />}
    </section>
  );
}

function DeliveryList({ order }: { order: Order }) {
  return (
    <section className="delivery-list">
      <div className="panel-title">
        <BadgeCheck size={18} />
        <h3>{order.status === "delivered" ? "发货内容" : "订单详情"}</h3>
      </div>
      {order.deliveredPayload.length === 0 ? (
        <p className="muted">订单尚未发货。</p>
      ) : (
        order.deliveredPayload.map((item, index) => (
          <div className="secret-line" key={item.id}>
            <span>{index + 1}</span>
            <code>{item.secret}</code>
            <button className="icon-button" type="button" title="复制" onClick={() => void navigator.clipboard.writeText(item.secret)}>
              <Clipboard size={16} />
            </button>
          </div>
        ))
      )}
    </section>
  );
}

function AuthPage({ customer, authMode, setAuthMode, authForm, setAuthForm, busy, onSubmit, onLogout, onOrders }: {
  customer: Customer | null;
  authMode: "login" | "register";
  setAuthMode: (mode: "login" | "register") => void;
  authForm: { email: string; password: string; name: string };
  setAuthForm: (form: { email: string; password: string; name: string }) => void;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
  onLogout: () => void;
  onOrders: () => void;
}) {
  if (customer) {
    return (
      <section className="auth-card">
        <ShieldCheck size={36} />
        <h1>{customer.name}</h1>
        <p>{customer.email}</p>
        <div className="auth-actions">
          <button className="primary-button" type="button" onClick={onOrders}>查看我的订单</button>
          <button className="ghost-button" type="button" onClick={onLogout}>退出登录</button>
        </div>
      </section>
    );
  }

  return (
    <section className="auth-card">
      <div className="auth-tabs">
        <button className={authMode === "login" ? "active" : ""} type="button" onClick={() => setAuthMode("login")}>登录</button>
        <button className={authMode === "register" ? "active" : ""} type="button" onClick={() => setAuthMode("register")}>注册</button>
      </div>
      <form onSubmit={onSubmit}>
        {authMode === "register" && (
          <label>
            昵称
            <input value={authForm.name} onChange={(event) => setAuthForm({ ...authForm, name: event.target.value })} placeholder="可选" />
          </label>
        )}
        <label>
          {authMode === "login" ? "邮箱 / 管理员账号" : "邮箱"}
          <input
            value={authForm.email}
            onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })}
            placeholder={authMode === "login" ? "you@example.com 或 admin" : "you@example.com"}
            required
          />
        </label>
        <label>
          密码
          <input type="password" value={authForm.password} onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })} placeholder="至少 6 位" required />
        </label>
        <button className="primary-button full" type="submit" disabled={busy}>
          <LogIn size={18} />
          {authMode === "register" ? "注册并登录" : "登录"}
        </button>
      </form>
    </section>
  );
}

function OrdersPage({ customer, accountOrders, guestOrders, lookupContact, setLookupContact, busy, onLookup, onLogin, onRefreshAccount, onRevealGuest }: {
  customer: Customer | null;
  accountOrders: Order[];
  guestOrders: Order[];
  lookupContact: string;
  setLookupContact: (value: string) => void;
  busy: boolean;
  onLookup: (event: FormEvent) => void;
  onLogin: () => void;
  onRefreshAccount: () => void;
  onRevealGuest: (order: Order) => void;
}) {
  return (
    <section className="orders-page">
      <div className="orders-card">
        <h1>{customer ? "我的订单" : "游客查单"}</h1>
        {customer ? (
          <div className="orders-toolbar">
            <span>{customer.email}</span>
            <button className="ghost-button" type="button" onClick={onRefreshAccount}>
              <RefreshCcw size={18} />
              刷新
            </button>
          </div>
        ) : (
          <form className="guest-lookup" onSubmit={onLookup}>
            <input value={lookupContact} onChange={(event) => setLookupContact(event.target.value)} placeholder="输入下单联系方式即可查单" required />
            <button className="primary-button" type="submit" disabled={busy}>
              <Search size={18} />
              查单
            </button>
            <button className="ghost-button" type="button" onClick={onLogin}>登录后自动保存订单</button>
          </form>
        )}
      </div>
      <OrderList orders={customer ? accountOrders : guestOrders} onReveal={customer ? undefined : onRevealGuest} />
    </section>
  );
}

function OrderList({ orders, onReveal }: { orders: Order[]; onReveal?: (order: Order) => void }) {
  if (orders.length === 0) return <div className="empty-state">暂无订单</div>;
  return (
    <div className="order-card-list">
      {orders.map((order) => {
        const hasMaskedSecrets = order.deliveredPayload.some((item) => item.secret.includes("****"));
        return (
          <article className="order-card" key={order.id}>
            <div>
              <h2>{order.productName}</h2>
              <p>{order.orderNo} · {order.contact}</p>
            </div>
            <b className={`status ${order.status}`}>{statusText[order.status]}</b>
            <strong>{money(order.totalCents)}</strong>
            {order.deliveredPayload.length > 0 && hasMaskedSecrets && onReveal && (
              <button className="ghost-button" type="button" onClick={() => onReveal(order)}>
                <Eye size={15} />
                查看发货内容
              </button>
            )}
            {order.deliveredPayload.length > 0 && (!hasMaskedSecrets || !onReveal) && <DeliveryList order={order} />}
          </article>
        );
      })}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AdminPanel({ onBack }: { onBack: () => void }) {
  const [token, setToken] = useState(() => localStorage.getItem("ddp_admin_token") || "");
  const [user, setUser] = useState<AdminUser | null>(null);
  const [tab, setTab] = useState<AdminTab>("dashboard");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loginForm, setLoginForm] = useState({ username: "admin", password: "ChangeMe123!" });
  const [categoryForm, setCategoryForm] = useState({ id: "", name: "", slug: "", sortOrder: 0, isActive: true });
  const [productForm, setProductForm] = useState<ProductForm>(emptyProductForm);
  const [inventoryProductId, setInventoryProductId] = useState("");
  const [inventoryLines, setInventoryLines] = useState("");
  const [paymentForm, setPaymentForm] = useState({ id: "", code: "", name: "", icon: "credit-card", description: "", sortOrder: 0, isActive: true });
  const [couponForm, setCouponForm] = useState({ id: "", code: "", type: "fixed", value: 500, minAmountCents: 0, totalLimit: 0, isActive: true });
  const [announcementForm, setAnnouncementForm] = useState({ id: "", title: "", content: "", level: "info", isActive: true });

  async function loadAll(authToken = token) {
    if (!authToken) return;
    setError("");
    try {
      const [
        statsPayload,
        categoryPayload,
        productPayload,
        orderPayload,
        inventoryPayload,
        couponPayload,
        paymentPayload,
        announcementPayload,
        settingsPayload
      ] = await Promise.all([
        api<AdminStats>("/api/admin/dashboard", { token: authToken }),
        api<Category[]>("/api/admin/categories", { token: authToken }),
        api<Product[]>("/api/admin/products", { token: authToken }),
        api<Order[]>("/api/admin/orders", { token: authToken }),
        api<InventoryItem[]>("/api/admin/inventory", { token: authToken }),
        api<Coupon[]>("/api/admin/coupons", { token: authToken }),
        api<PaymentMethod[]>("/api/admin/payment-methods", { token: authToken }),
        api<Announcement[]>("/api/admin/announcements", { token: authToken }),
        api<Record<string, string>>("/api/admin/settings", { token: authToken })
      ]);
      setStats(statsPayload);
      setCategories(categoryPayload);
      setProducts(productPayload);
      setOrders(orderPayload);
      setInventory(inventoryPayload);
      setCoupons(couponPayload);
      setPaymentMethods(paymentPayload);
      setAnnouncements(announcementPayload);
      setSettings(settingsPayload);
      if (!productForm.categoryId && categoryPayload[0]) setProductForm((form) => ({ ...form, categoryId: categoryPayload[0].id }));
      if (!inventoryProductId && productPayload[0]) setInventoryProductId(productPayload[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "后台数据加载失败");
    }
  }

  useEffect(() => {
    if (token) void loadAll(token);
  }, [token]);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ token: string; user: AdminUser }>("/api/admin/login", {
        method: "POST",
        body: JSON.stringify(loginForm)
      });
      localStorage.setItem("ddp_admin_token", result.token);
      setToken(result.token);
      setUser(result.user);
      setMessage("已进入后台");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  }

  async function mutate(action: () => Promise<unknown>, success: string) {
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  }

  async function saveCategory(event: FormEvent) {
    event.preventDefault();
    const path = categoryForm.id ? `/api/admin/categories/${categoryForm.id}` : "/api/admin/categories";
    const method = categoryForm.id ? "PATCH" : "POST";
    await mutate(() => api(path, { token, method, body: JSON.stringify(categoryForm) }), "分类已保存");
    setCategoryForm({ id: "", name: "", slug: "", sortOrder: 0, isActive: true });
  }

  async function saveProduct(event: FormEvent) {
    event.preventDefault();
    const payload = { ...productForm, tags: productForm.tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
    const path = productForm.id ? `/api/admin/products/${productForm.id}` : "/api/admin/products";
    const method = productForm.id ? "PATCH" : "POST";
    await mutate(() => api(path, { token, method, body: JSON.stringify(payload) }), "商品已保存");
    setProductForm({ ...emptyProductForm, categoryId: categories[0]?.id || "" });
  }

  async function saveInventory(event: FormEvent) {
    event.preventDefault();
    await mutate(() => api(`/api/admin/products/${inventoryProductId}/inventory`, {
      token,
      method: "POST",
      body: JSON.stringify({ lines: inventoryLines })
    }), "库存已导入");
    setInventoryLines("");
  }

  async function savePayment(event: FormEvent) {
    event.preventDefault();
    const path = paymentForm.id ? `/api/admin/payment-methods/${paymentForm.id}` : "/api/admin/payment-methods";
    const method = paymentForm.id ? "PATCH" : "POST";
    await mutate(() => api(path, { token, method, body: JSON.stringify(paymentForm) }), "支付方式已保存");
    setPaymentForm({ id: "", code: "", name: "", icon: "credit-card", description: "", sortOrder: 0, isActive: true });
  }

  async function saveCoupon(event: FormEvent) {
    event.preventDefault();
    const path = couponForm.id ? `/api/admin/coupons/${couponForm.id}` : "/api/admin/coupons";
    const method = couponForm.id ? "PATCH" : "POST";
    await mutate(() => api(path, { token, method, body: JSON.stringify(couponForm) }), "优惠券已保存");
    setCouponForm({ id: "", code: "", type: "fixed", value: 500, minAmountCents: 0, totalLimit: 0, isActive: true });
  }

  async function saveAnnouncement(event: FormEvent) {
    event.preventDefault();
    const path = announcementForm.id ? `/api/admin/announcements/${announcementForm.id}` : "/api/admin/announcements";
    const method = announcementForm.id ? "PATCH" : "POST";
    await mutate(() => api(path, {
      token,
      method,
      body: JSON.stringify(announcementForm)
    }), "公告已发布");
    setAnnouncementForm({ id: "", title: "", content: "", level: "info", isActive: true });
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    await mutate(() => api("/api/admin/settings", { token, method: "PATCH", body: JSON.stringify(settings) }), "店铺设置已更新");
  }

  async function deleteResource(path: string, label: string, success: string) {
    if (!window.confirm(`确认删除「${label}」？此操作不可恢复。`)) return;
    await mutate(() => api(path, { token, method: "DELETE" }), success);
  }

  async function removeCategory(category: Category) {
    await deleteResource(`/api/admin/categories/${category.id}`, category.name, "分类已删除");
    if (categoryForm.id === category.id) setCategoryForm({ id: "", name: "", slug: "", sortOrder: 0, isActive: true });
  }

  async function removeProduct(product: Product) {
    await deleteResource(`/api/admin/products/${product.id}`, product.name, "商品已删除");
    if (productForm.id === product.id) setProductForm({ ...emptyProductForm, categoryId: categories[0]?.id || "" });
  }

  async function removeInventoryItem(item: InventoryItem) {
    await deleteResource(`/api/admin/inventory/${item.id}`, item.secret, "库存卡密已删除");
  }

  async function removeOrder(order: Order) {
    await deleteResource(`/api/admin/orders/${order.id}`, order.orderNo, "订单已删除");
  }

  async function removePayment(method: PaymentMethod) {
    await deleteResource(`/api/admin/payment-methods/${method.id}`, method.name, "支付方式已删除");
    if (paymentForm.id === method.id) setPaymentForm({ id: "", code: "", name: "", icon: "credit-card", description: "", sortOrder: 0, isActive: true });
  }

  async function removeCoupon(coupon: Coupon) {
    await deleteResource(`/api/admin/coupons/${coupon.id}`, coupon.code, "优惠券已删除");
    if (couponForm.id === coupon.id) setCouponForm({ id: "", code: "", type: "fixed", value: 500, minAmountCents: 0, totalLimit: 0, isActive: true });
  }

  async function removeAnnouncement(announcement: Announcement) {
    await deleteResource(`/api/admin/announcements/${announcement.id}`, announcement.title, "公告已删除");
    if (announcementForm.id === announcement.id) setAnnouncementForm({ id: "", title: "", content: "", level: "info", isActive: true });
  }

  function logout() {
    localStorage.removeItem("ddp_admin_token");
    setToken("");
    setUser(null);
  }

  function editProduct(product: Product) {
    setTab("products");
    setProductForm({
      id: product.id,
      categoryId: product.categoryId,
      name: product.name,
      slug: product.slug,
      subtitle: product.subtitle,
      description: product.description,
      priceCents: product.priceCents,
      marketPriceCents: product.marketPriceCents,
      coverUrl: product.coverUrl,
      tags: product.tags.join(","),
      buyLimit: product.buyLimit,
      isActive: product.isActive,
      sortOrder: product.sortOrder
    });
  }

  function editCoupon(coupon: Coupon) {
    setTab("coupons");
    setCouponForm({
      id: coupon.id,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      minAmountCents: coupon.minAmountCents,
      totalLimit: coupon.totalLimit,
      isActive: coupon.isActive
    });
  }

  function editAnnouncement(announcement: Announcement) {
    setTab("announcements");
    setAnnouncementForm({
      id: announcement.id,
      title: announcement.title,
      content: announcement.content,
      level: announcement.level,
      isActive: announcement.isActive
    });
  }

  const warningLimit = Number(settings.stock_warning || 3) || 3;
  const pendingOrderCount = orders.filter((order) => order.status === "pending").length;
  const lowStockCount = products.filter((product) => product.stock <= warningLimit).length;
  const reservedInventoryCount = inventory.filter((item) => item.status === "reserved").length;

  if (!token) {
    return (
      <main className="admin-login">
        <button className="ghost-button back" type="button" onClick={onBack}>
          <ChevronLeft size={18} />
          返回店铺
        </button>
        <form className="login-card" onSubmit={submitLogin}>
          <ShieldCheck size={34} />
          <h1>后台管理</h1>
          <label>
            账号
            <input value={loginForm.username} onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })} />
          </label>
          <label>
            密码
            <input type="password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} />
          </label>
          {error && <div className="alert error">{error}</div>}
          <button className="primary-button" type="submit">
            <LogIn size={18} />
            登录
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <button className="brand admin-brand" type="button" onClick={onBack}>
          <Store size={23} />
          <span>发货后台</span>
        </button>
        <div className="admin-user">
          <ShieldCheck size={18} />
          <div>
            <span>{user?.username || "admin"}</span>
            <small>管理员在线</small>
          </div>
        </div>
        <div className="admin-sidebar-summary">
          <div>
            <span>待处理</span>
            <strong>{pendingOrderCount}</strong>
          </div>
          <div>
            <span>低库存</span>
            <strong>{lowStockCount}</strong>
          </div>
        </div>
        <nav className="admin-nav">
          <AdminNavButton icon={<Gauge size={18} />} label="概览" tab="dashboard" current={tab} onClick={setTab} />
          <AdminNavButton icon={<Layers3 size={18} />} label="分类" tab="categories" current={tab} onClick={setTab} />
          <AdminNavButton icon={<Package size={18} />} label="商品" tab="products" current={tab} onClick={setTab} />
          <AdminNavButton icon={<Boxes size={18} />} label="库存" tab="inventory" current={tab} onClick={setTab} />
          <AdminNavButton icon={<FileText size={18} />} label="订单" tab="orders" current={tab} onClick={setTab} />
          <AdminNavButton icon={<CreditCard size={18} />} label="支付" tab="payments" current={tab} onClick={setTab} />
          <AdminNavButton icon={<Tags size={18} />} label="优惠券" tab="coupons" current={tab} onClick={setTab} />
          <AdminNavButton icon={<Megaphone size={18} />} label="公告" tab="announcements" current={tab} onClick={setTab} />
          <AdminNavButton icon={<Settings size={18} />} label="设置" tab="settings" current={tab} onClick={setTab} />
        </nav>
        <button className="ghost-button full" type="button" onClick={logout}>退出</button>
      </aside>

      <section className="admin-content">
        <div className="admin-head">
          <div>
            <p className="eyebrow">Digital Delivery Ops</p>
            <h1>{adminTabTitle(tab)}</h1>
            <span>商品、库存、订单和支付配置集中管理</span>
          </div>
          <div className="admin-head-actions">
            <div className="admin-head-stats">
              <span>订单 <b>{orders.length}</b></span>
              <span>可售 <b>{stats?.availableStock || 0}</b></span>
              <span>锁定 <b>{reservedInventoryCount}</b></span>
            </div>
            <button className="ghost-button" type="button" onClick={() => void loadAll()}>
              <RefreshCcw size={18} />
              刷新数据
            </button>
          </div>
        </div>
        {message && <div className="alert success"><Check size={18} />{message}</div>}
        {error && <div className="alert error"><X size={18} />{error}</div>}

        {tab === "dashboard" && <Dashboard stats={stats} products={products} orders={orders} inventory={inventory} />}
        {tab === "categories" && (
          <CategoriesAdmin
            categories={categories}
            products={products}
            form={categoryForm}
            setForm={setCategoryForm}
            onSubmit={saveCategory}
            onDelete={removeCategory}
          />
        )}
        {tab === "products" && (
          <ProductsAdmin
            categories={categories}
            products={products}
            form={productForm}
            setForm={setProductForm}
            onSubmit={saveProduct}
            onEdit={editProduct}
            onDelete={removeProduct}
          />
        )}
        {tab === "inventory" && (
          <InventoryAdmin
            products={products}
            inventory={inventory}
            productId={inventoryProductId}
            setProductId={setInventoryProductId}
            lines={inventoryLines}
            setLines={setInventoryLines}
            onSubmit={saveInventory}
            onDelete={removeInventoryItem}
          />
        )}
        {tab === "orders" && (
          <OrdersAdmin
            token={token}
            orders={orders}
            onStatus={(orderId, status) => mutate(() => api(`/api/admin/orders/${orderId}`, {
              token,
              method: "PATCH",
              body: JSON.stringify({ status })
            }), "订单状态已更新")}
            onDelete={removeOrder}
          />
        )}
        {tab === "payments" && (
          <PaymentsAdmin methods={paymentMethods} form={paymentForm} setForm={setPaymentForm} onSubmit={savePayment} onDelete={removePayment} />
        )}
        {tab === "coupons" && <CouponsAdmin coupons={coupons} form={couponForm} setForm={setCouponForm} onSubmit={saveCoupon} onEdit={editCoupon} onDelete={removeCoupon} />}
        {tab === "announcements" && (
          <AnnouncementsAdmin announcements={announcements} form={announcementForm} setForm={setAnnouncementForm} onSubmit={saveAnnouncement} onEdit={editAnnouncement} onDelete={removeAnnouncement} />
        )}
        {tab === "settings" && <SettingsAdmin settings={settings} setSettings={setSettings} onSubmit={saveSettings} />}
      </section>
    </main>
  );
}

function AdminNavButton({ icon, label, tab, current, onClick }: {
  icon: React.ReactNode;
  label: string;
  tab: AdminTab;
  current: AdminTab;
  onClick: (tab: AdminTab) => void;
}) {
  return (
    <button className={current === tab ? "active" : ""} type="button" onClick={() => onClick(tab)}>
      {icon}
      {label}
    </button>
  );
}

function adminTabTitle(tab: AdminTab) {
  const titles: Record<AdminTab, string> = {
    dashboard: "经营概览",
    categories: "商品分类",
    products: "商品管理",
    inventory: "库存卡密",
    orders: "订单管理",
    payments: "支付配置",
    coupons: "优惠券",
    announcements: "公告管理",
    settings: "店铺设置"
  };
  return titles[tab];
}

function Dashboard({ stats, products, orders, inventory }: {
  stats: AdminStats | null;
  products: Product[];
  orders: Order[];
  inventory: InventoryItem[];
}) {
  const warningProducts = products.filter((product) => product.stock <= 3);
  const reservedCount = inventory.filter((item) => item.status === "reserved").length;
  const deliveredCount = stats?.deliveredCount || 0;
  const orderCount = stats?.orderCount || 0;
  const deliveryRate = orderCount ? Math.round((deliveredCount / orderCount) * 100) : 0;
  return (
    <div className="admin-stack">
      <section className="admin-command-card">
        <div>
          <p className="eyebrow">运营状态</p>
          <h2>交易、库存与发货状态</h2>
          <span>保持商品可售、卡密可发、订单可追踪，是自动发货站点的核心节奏。</span>
        </div>
        <div className="admin-command-metrics">
          <span>发货率 <b>{deliveryRate}%</b></span>
          <span>低库存 <b>{warningProducts.length}</b></span>
          <span>锁定中 <b>{reservedCount}</b></span>
        </div>
      </section>
      <div className="stats-grid">
        <Metric label="成交额" value={money(stats?.revenueCents || 0)} />
        <Metric label="订单数" value={stats?.orderCount || 0} />
        <Metric label="已发货" value={stats?.deliveredCount || 0} />
        <Metric label="待支付" value={stats?.pendingCount || 0} />
        <Metric label="锁定库存" value={reservedCount} />
        <Metric label="可售库存" value={stats?.availableStock || 0} />
      </div>
      <div className="admin-two-col">
        <section className="admin-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Inventory</p>
              <h2>商品库存联动</h2>
            </div>
            <b className="status pending">{warningProducts.length} 项预警</b>
          </div>
          {warningProducts.length === 0 ? <p className="muted">暂无低库存商品</p> : warningProducts.map((product) => (
            <div className="list-row" key={product.id}>
              <span>{product.categoryName} · {product.name}</span>
              <b className="status pending">库存 {product.stock}</b>
            </div>
          ))}
        </section>
        <section className="admin-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Orders</p>
              <h2>最近订单</h2>
            </div>
            <b className="status delivered">{orders.length} 单</b>
          </div>
          {orders.slice(0, 8).map((order) => (
            <div className="list-row" key={order.id}>
              <span>{order.productName} × {order.quantity}<small>{order.orderNo}</small></span>
              <b className={`status ${order.status}`}>{statusText[order.status]}</b>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function CategoriesAdmin({ categories, products, form, setForm, onSubmit, onDelete }: {
  categories: Category[];
  products: Product[];
  form: any;
  setForm: (form: any) => void;
  onSubmit: (event: FormEvent) => void;
  onDelete: (category: Category) => void;
}) {
  return (
    <div className="admin-two-col">
      <form className="admin-section form-grid" onSubmit={onSubmit}>
        <h2>{form.id ? "编辑分类" : "新增分类"}</h2>
        <label>
          名称
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
        </label>
        <label>
          标识
          <input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} required />
        </label>
        <label>
          排序
          <input type="number" value={form.sortOrder} onChange={(event) => setForm({ ...form, sortOrder: Number(event.target.value) })} />
        </label>
        <label className="toggle-line">
          <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
          启用
        </label>
        <button className="primary-button" type="submit">
          <Plus size={18} />
          保存分类
        </button>
      </form>
      <section className="admin-section">
        <h2>分类与商品</h2>
        {categories.map((category) => {
          const linkedProducts = products.filter((product) => product.categoryId === category.id);
          return (
            <div className="relation-row" key={category.id}>
              <span>
                <strong>{category.name}</strong>
                <small>{linkedProducts.map((product) => product.name).join(" / ") || "暂无商品"}</small>
              </span>
              <b>{linkedProducts.length}</b>
              <div className="row-actions">
                <button type="button" onClick={() => setForm({ id: category.id, name: category.name, slug: category.slug, sortOrder: category.sortOrder, isActive: category.isActive })}>
                  <Pencil size={15} />
                  编辑
                </button>
                <button className="danger-button" type="button" onClick={() => onDelete(category)}>
                  <Trash2 size={15} />
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function ProductsAdmin({ categories, products, form, setForm, onSubmit, onEdit, onDelete }: {
  categories: Category[];
  products: Product[];
  form: ProductForm;
  setForm: (form: ProductForm) => void;
  onSubmit: (event: FormEvent) => void;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
}) {
  return (
    <div className="admin-two-col">
      <form className="admin-section form-grid" onSubmit={onSubmit}>
        <h2>{form.id ? "编辑商品" : "新增商品"}</h2>
        <label>
          分类
          <select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
        <label>
          名称
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
        </label>
        <label>
          访问标识
          <input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} required />
        </label>
        <label>
          标语
          <input value={form.subtitle} onChange={(event) => setForm({ ...form, subtitle: event.target.value })} />
        </label>
        <label>
          价格（分）
          <input type="number" value={form.priceCents} onChange={(event) => setForm({ ...form, priceCents: Number(event.target.value) })} />
        </label>
        <label>
          原价（分）
          <input type="number" value={form.marketPriceCents} onChange={(event) => setForm({ ...form, marketPriceCents: Number(event.target.value) })} />
        </label>
        <label>
          限购
          <input type="number" value={form.buyLimit} onChange={(event) => setForm({ ...form, buyLimit: Number(event.target.value) })} />
        </label>
        <label>
          排序
          <input type="number" value={form.sortOrder} onChange={(event) => setForm({ ...form, sortOrder: Number(event.target.value) })} />
        </label>
        <label className="wide">
          封面 URL
          <input value={form.coverUrl} onChange={(event) => setForm({ ...form, coverUrl: event.target.value })} />
        </label>
        <label className="wide">
          标签
          <input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
        </label>
        <label className="wide">
          说明
          <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={4} />
        </label>
        <label className="toggle-line wide">
          <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
          上架
        </label>
        <button className="primary-button" type="submit">
          <Plus size={18} />
          保存商品
        </button>
      </form>
      <section className="admin-section">
        <h2>商品与库存</h2>
        <div className="table-list">
          {products.map((product) => (
            <div className="product-row" key={product.id}>
              <img src={product.coverUrl || fallbackCover} alt={product.name} />
              <span>
                <strong>{product.name}</strong>
                <small>{product.categoryName} · {money(product.priceCents)} · 库存 {product.stock} · 已售 {product.sold}</small>
              </span>
              <b className={product.isActive ? "status delivered" : "status closed"}>{product.isActive ? "上架" : "下架"}</b>
              <div className="row-actions">
                <button type="button" onClick={() => onEdit(product)}>
                  <Pencil size={15} />
                  编辑
                </button>
                <button className="danger-button" type="button" onClick={() => onDelete(product)}>
                  <Trash2 size={15} />
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function InventoryAdmin({ products, inventory, productId, setProductId, lines, setLines, onSubmit, onDelete }: {
  products: Product[];
  inventory: InventoryItem[];
  productId: string;
  setProductId: (id: string) => void;
  lines: string;
  setLines: (lines: string) => void;
  onSubmit: (event: FormEvent) => void;
  onDelete: (item: InventoryItem) => void;
}) {
  const selected = products.find((product) => product.id === productId);
  const visibleInventory = inventory.filter((item) => item.productId === productId);
  const inventoryTitle = selected ? `${selected.name} 库存` : "最近库存";
  return (
    <div className="admin-two-col">
      <form className="admin-section" onSubmit={onSubmit}>
        <h2>导入卡密</h2>
        <label>
          商品
          <select value={productId} onChange={(event) => setProductId(event.target.value)}>
            {products.map((product) => <option key={product.id} value={product.id}>{product.categoryName} / {product.name}</option>)}
          </select>
        </label>
        {selected && <div className="relation-card">当前商品库存：<b>{selected.stock}</b>，已售：<b>{selected.sold}</b></div>}
        <label>
          卡密内容
          <textarea value={lines} onChange={(event) => setLines(event.target.value)} rows={12} placeholder="一行一条卡密" />
        </label>
        <button className="primary-button" type="submit">
          <Gift size={18} />
          导入库存
        </button>
      </form>
      <section className="admin-section">
        <div className="section-head">
          <div>
            <h2>{inventoryTitle}</h2>
            <span>{selected ? `${selected.categoryName || "未分类"} · 当前显示 ${visibleInventory.length} 条卡密` : "请选择商品查看库存"}</span>
          </div>
        </div>
        <div className="inventory-list">
          {visibleInventory.length === 0 ? (
            <div className="empty-state">当前商品暂无库存卡密</div>
          ) : (
            visibleInventory.slice(0, 100).map((item) => (
              <div className="inventory-row" key={item.id}>
                <span>
                  <strong>{item.productName}</strong>
                  <code>{item.secret}</code>
                </span>
                <b className={`status ${item.status}`}>{statusText[item.status]}</b>
                <div className="row-actions">
                  <button className="danger-button" type="button" onClick={() => onDelete(item)}>
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function OrdersAdmin({ token, orders, onStatus, onDelete }: {
  token: string;
  orders: Order[];
  onStatus: (orderId: string, status: string) => void;
  onDelete: (order: Order) => void;
}) {
  const [secretOrder, setSecretOrder] = useState<Order | null>(null);

  return (
    <section className="admin-section">
      <h2>订单列表</h2>
      <div className="responsive-table">
        <table>
          <thead>
            <tr>
              <th>订单号</th>
              <th>商品</th>
              <th>金额</th>
              <th>支付</th>
              <th>联系</th>
              <th>发货卡密</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>{order.orderNo}</td>
                <td>{order.productName} × {order.quantity}</td>
                <td>{money(order.totalCents)}</td>
                <td>{order.paymentMethod}</td>
                <td>{order.contact}</td>
                <td><AdminDeliverySecrets order={order} onOpen={() => setSecretOrder(order)} /></td>
                <td><b className={`status ${order.status}`}>{statusText[order.status]}</b></td>
                <td>
                  <div className="row-actions">
                    {order.status === "pending" && <button type="button" onClick={() => onStatus(order.id, "closed")}>关闭</button>}
                    {order.status === "delivered" && <button type="button" onClick={() => onStatus(order.id, "refunded")}>退款标记</button>}
                    <button className="danger-button" type="button" onClick={() => onDelete(order)}>
                      <Trash2 size={15} />
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {secretOrder && <AdminSecretModal token={token} order={secretOrder} onClose={() => setSecretOrder(null)} />}
    </section>
  );
}

function AdminDeliverySecrets({ order, onOpen }: { order: Order; onOpen: () => void }) {
  if (!order.deliveredPayload.length) {
    return <span className="admin-secret-empty">{order.status === "delivered" ? "暂无卡密记录" : "未发货"}</span>;
  }

  return (
    <button className="admin-secret-trigger" type="button" onClick={onOpen}>
      <Eye size={15} />
      查看卡密
      <span>{order.deliveredPayload.length}</span>
    </button>
  );
}

function AdminSecretModal({ token, order, onClose }: { token: string; order: Order; onClose: () => void }) {
  const [items, setItems] = useState(order.deliveredPayload);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const secretText = items.map((item) => item.secret).join("\n");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<DeliveredItem[]>(`/api/admin/orders/${order.id}/secrets`, { token })
      .then((payload) => {
        if (active) setItems(payload);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "卡密加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [order.id, token]);

  return (
    <div className="admin-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="admin-secret-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${order.orderNo} 发货卡密`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="admin-secret-modal-head">
          <div>
            <span>发货卡密</span>
            <h3>{order.productName} × {order.quantity}</h3>
            <p>{order.orderNo} · {order.contact}</p>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="admin-secret-modal-list">
          {loading && <div className="empty-state">正在加载卡密...</div>}
          {!loading && error && <div className="alert error">{error}</div>}
          {!loading && !error && items.map((item, index) => (
            <div className="admin-secret-row" key={`${item.id}-${index}`}>
              <span>{index + 1}</span>
              <code title={item.secret}>{item.secret}</code>
              <button
                className="icon-button"
                type="button"
                title="复制卡密"
                onClick={() => void navigator.clipboard.writeText(item.secret)}
              >
                <Clipboard size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="admin-secret-modal-actions">
          <button className="ghost-button" type="button" onClick={() => void navigator.clipboard.writeText(secretText)} disabled={loading || !secretText}>
            <Clipboard size={16} />
            复制全部
          </button>
          <button className="primary-button" type="button" onClick={onClose}>关闭</button>
        </div>
      </section>
    </div>
  );
}

function PaymentsAdmin({ methods, form, setForm, onSubmit, onDelete }: {
  methods: PaymentMethod[];
  form: any;
  setForm: (form: any) => void;
  onSubmit: (event: FormEvent) => void;
  onDelete: (method: PaymentMethod) => void;
}) {
  return (
    <div className="admin-two-col">
      <form className="admin-section form-grid" onSubmit={onSubmit}>
        <h2>{form.id ? "编辑支付方式" : "新增支付方式"}</h2>
        <label>
          代码
          <input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} required />
        </label>
        <label>
          名称
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
        </label>
        <label>
          图标
          <select value={form.icon} onChange={(event) => setForm({ ...form, icon: event.target.value })}>
            <option value="credit-card">银行卡</option>
            <option value="qr-code">二维码</option>
            <option value="message-circle">聊天支付</option>
          </select>
        </label>
        <label>
          排序
          <input type="number" value={form.sortOrder} onChange={(event) => setForm({ ...form, sortOrder: Number(event.target.value) })} />
        </label>
        <label className="wide">
          说明
          <textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={4} />
        </label>
        <label className="toggle-line wide">
          <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
          启用
        </label>
        <button className="primary-button" type="submit">
          <CreditCard size={18} />
          保存支付方式
        </button>
      </form>
      <section className="admin-section">
        <h2>收银台通道</h2>
        {methods.map((method) => (
          <div className="relation-row" key={method.id}>
            <span>
              <strong>{method.name}</strong>
              <small>{method.code} · {method.description}</small>
            </span>
            <b className={method.isActive ? "status delivered" : "status closed"}>{method.isActive ? "启用" : "停用"}</b>
            <div className="row-actions">
              <button type="button" onClick={() => setForm(method)}>
                <Pencil size={15} />
                编辑
              </button>
              <button className="danger-button" type="button" onClick={() => onDelete(method)}>
                <Trash2 size={15} />
                删除
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function CouponsAdmin({ coupons, form, setForm, onSubmit, onEdit, onDelete }: {
  coupons: Coupon[];
  form: any;
  setForm: (form: any) => void;
  onSubmit: (event: FormEvent) => void;
  onEdit: (coupon: Coupon) => void;
  onDelete: (coupon: Coupon) => void;
}) {
  return (
    <div className="admin-two-col">
      <form className="admin-section form-grid" onSubmit={onSubmit}>
        <h2>{form.id ? "编辑优惠券" : "新增优惠券"}</h2>
        <label>
          优惠码
          <input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} required />
        </label>
        <label>
          类型
          <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
            <option value="fixed">固定金额</option>
            <option value="percent">百分比</option>
          </select>
        </label>
        <label>
          优惠值
          <input type="number" value={form.value} onChange={(event) => setForm({ ...form, value: Number(event.target.value) })} />
        </label>
        <label>
          门槛（分）
          <input type="number" value={form.minAmountCents} onChange={(event) => setForm({ ...form, minAmountCents: Number(event.target.value) })} />
        </label>
        <label>
          总次数
          <input type="number" value={form.totalLimit} onChange={(event) => setForm({ ...form, totalLimit: Number(event.target.value) })} />
        </label>
        <label className="toggle-line">
          <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
          启用
        </label>
        <button className="primary-button" type="submit">
          <Plus size={18} />
          保存优惠券
        </button>
      </form>
      <section className="admin-section">
        <h2>优惠券列表</h2>
        {coupons.map((coupon) => (
          <div className="list-row" key={coupon.id}>
            <span>{coupon.code}</span>
            <b>{coupon.type === "percent" ? `${coupon.value}%` : money(coupon.value)}</b>
            <small>已用 {coupon.usedCount}/{coupon.totalLimit || "不限"}</small>
            <div className="row-actions">
              <button type="button" onClick={() => onEdit(coupon)}>
                <Pencil size={15} />
                编辑
              </button>
              <button className="danger-button" type="button" onClick={() => onDelete(coupon)}>
                <Trash2 size={15} />
                删除
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function AnnouncementsAdmin({ announcements, form, setForm, onSubmit, onEdit, onDelete }: {
  announcements: Announcement[];
  form: any;
  setForm: (form: any) => void;
  onSubmit: (event: FormEvent) => void;
  onEdit: (announcement: Announcement) => void;
  onDelete: (announcement: Announcement) => void;
}) {
  return (
    <div className="admin-two-col">
      <form className="admin-section" onSubmit={onSubmit}>
        <h2>{form.id ? "编辑公告" : "发布公告"}</h2>
        <label>
          标题
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required />
        </label>
        <label>
          内容
          <textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} rows={5} required />
        </label>
        <label>
          等级
          <select value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })}>
            <option value="info">普通</option>
            <option value="success">成功</option>
            <option value="warning">警告</option>
          </select>
        </label>
        <button className="primary-button" type="submit">
          <Megaphone size={18} />
          {form.id ? "保存公告" : "发布"}
        </button>
      </form>
      <section className="admin-section">
        <h2>公告列表</h2>
        {announcements.map((announcement) => (
          <div className={`notice ${announcement.level}`} key={announcement.id}>
            <Megaphone size={17} />
            <strong>{announcement.title}</strong>
            <span>{announcement.content}</span>
            <div className="row-actions">
              <button type="button" onClick={() => onEdit(announcement)}>
                <Pencil size={15} />
                编辑
              </button>
              <button className="danger-button" type="button" onClick={() => onDelete(announcement)}>
                <Trash2 size={15} />
                删除
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function SettingsAdmin({ settings, setSettings, onSubmit }: {
  settings: Record<string, string>;
  setSettings: (settings: Record<string, string>) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="admin-section settings-form" onSubmit={onSubmit}>
      <label>
        店铺名称
        <input value={settings.store_name || ""} onChange={(event) => setSettings({ ...settings, store_name: event.target.value })} />
      </label>
      <label>
        店铺标语
        <input value={settings.store_slogan || ""} onChange={(event) => setSettings({ ...settings, store_slogan: event.target.value })} />
      </label>
      <label>
        售后邮箱
        <input value={settings.support_email || ""} onChange={(event) => setSettings({ ...settings, support_email: event.target.value })} />
      </label>
      <label>
        售后时间
        <input value={settings.support_hours || ""} onChange={(event) => setSettings({ ...settings, support_hours: event.target.value })} />
      </label>
      <label>
        库存预警阈值
        <input value={settings.stock_warning || ""} onChange={(event) => setSettings({ ...settings, stock_warning: event.target.value })} />
      </label>
      <label>
        支付提示
        <textarea value={settings.payment_notice || ""} onChange={(event) => setSettings({ ...settings, payment_notice: event.target.value })} rows={3} />
      </label>
      <label>
        下单提示
        <textarea value={settings.checkout_tips || ""} onChange={(event) => setSettings({ ...settings, checkout_tips: event.target.value })} rows={3} />
      </label>
      <button className="primary-button" type="submit">
        <Settings size={18} />
        保存设置
      </button>
    </form>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
