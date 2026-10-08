// KORASTORE shared client: Firebase Auth/Firestore, Worker API calls, cart, formatting and page shells.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, collection, query, where,
  orderBy, limit, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig, API_BASE, ADMIN_EMAIL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
export { signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut };

const noop = () => {};
const rows = (snap) => snap.docs.map((item) => ({ ...item.data(), id: item.id }));

// ---------- Formatting ----------
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);
export const naira = (value) => `₦${Math.round(Number(value) || 0).toLocaleString("en-NG")}`;
export function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
export function formatDate(value) {
  const date = toDate(value);
  return date ? new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric" }).format(date) : "—";
}
export function formatDateTime(value) {
  const date = toDate(value);
  return date ? new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date) : "—";
}
export const initials = (text) => String(text || "K").trim().split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "K";

export const ORDER_STEPS = ["paid", "processing", "shipped", "delivered"];
export const STATUS_LABEL = {
  paid: "Paid", processing: "Processing", shipped: "Shipped", delivered: "Delivered",
  cancelled: "Cancelled", pending: "Pending", approved: "Approved", rejected: "Rejected", refunded: "Refunded"
};
export function statusClass(status) {
  if (["delivered", "approved", "paid", "refunded"].includes(status)) return "ok";
  if (["cancelled", "rejected"].includes(status)) return "bad";
  return "wait";
}

// ---------- Auth and profile ----------
export async function ensureUserProfile(user, name = "") {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, { name: name || user.displayName || "", email: user.email || "", createdAt: serverTimestamp() });
}

export function watchProfile(uid, callback, onError = noop) {
  return onSnapshot(doc(db, "users", uid), (snap) => callback(snap.exists() ? { ...snap.data(), id: uid } : { id: uid }), onError);
}

export async function saveLocation(uid, location) {
  await updateDoc(doc(db, "users", uid), {
    name: location.name,
    country: location.country,
    state: location.state,
    lga: location.lga,
    address: location.address,
    updatedAt: serverTimestamp()
  });
}

// ---------- Catalogue ----------
// Public browse: only active products. Admin sees all products.
export function watchProducts(callback, onError = noop, { includeInactive = false } = {}) {
  const ref = includeInactive ? collection(db, "products") : query(collection(db, "products"), where("active", "==", true));
  return onSnapshot(ref, (snap) => callback(rows(snap)), onError);
}

export async function getProduct(id) {
  const snap = await getDoc(doc(db, "products", id));
  return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

export function saveProduct(id, data) {
  const payload = { ...data, updatedAt: serverTimestamp() };
  if (id) return updateDoc(doc(db, "products", id), payload);
  return addDoc(collection(db, "products"), { ...payload, sold: 0, createdAt: serverTimestamp() });
}

export function watchPaymentSettings(callback, onError = noop) {
  return onSnapshot(doc(db, "settings", "payment"), (snap) => callback(snap.exists() ? snap.data() : null), onError);
}

export function savePaymentSettings(data) {
  return setDoc(doc(db, "settings", "payment"), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

// ---------- Customer data ----------
export function watchMyOrders(uid, callback, onError = noop) {
  return onSnapshot(query(collection(db, "orders"), where("uid", "==", uid)), (snap) => {
    callback(rows(snap).sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)));
  }, onError);
}

export function watchMyTransactions(uid, callback, onError = noop, max = 25) {
  return onSnapshot(query(collection(db, "users", uid, "transactions"), orderBy("createdAt", "desc"), limit(max)),
    (snap) => callback(rows(snap)), onError);
}

export function watchMyFunding(uid, callback, onError = noop) {
  return onSnapshot(query(collection(db, "fundingRequests"), where("uid", "==", uid)), (snap) => {
    callback(rows(snap).sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)));
  }, onError);
}

export function createFundingRequest(uid, amount, reference) {
  return addDoc(collection(db, "fundingRequests"), {
    uid,
    amount: Math.round(Number(amount)),
    reference: String(reference).trim(),
    status: "pending",
    createdAt: serverTimestamp()
  });
}

// ---------- Admin reads ----------
export function watchAllOrders(callback, onError = noop) {
  return onSnapshot(collection(db, "orders"), (snap) => {
    callback(rows(snap).sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)));
  }, onError);
}
export function watchAllFunding(callback, onError = noop) {
  return onSnapshot(collection(db, "fundingRequests"), (snap) => {
    callback(rows(snap).sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)));
  }, onError);
}
export function watchAllUsers(callback, onError = noop) {
  return onSnapshot(collection(db, "users"), (snap) => callback(rows(snap)), onError);
}

// ---------- Worker API ----------
export async function apiPost(path, body) {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const base = String(API_BASE || "/api").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
  return data;
}

export const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ---------- Cart (kept on this device; the Worker re-prices everything at checkout) ----------
const CART_KEY = "korastore-cart";
export function getCart() {
  try {
    const items = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    return Array.isArray(items) ? items.filter((i) => i && typeof i.productId === "string" && i.quantity > 0) : [];
  } catch {
    return [];
  }
}
export function setCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent("korastore:cart"));
}
export function addToCart(productId, quantity = 1) {
  const items = getCart();
  const found = items.find((i) => i.productId === productId);
  if (found) found.quantity = Math.min(50, found.quantity + quantity);
  else items.push({ productId, quantity: Math.min(50, quantity) });
  setCart(items);
}

// ---------- Page shells ----------
const NAV = [
  ["shop.html", "Shop"],
  ["cart.html", "Cart"],
  ["dashboard.html", "Account"]
];

export function mountHeader(active) {
  const host = document.querySelector("#site-header");
  if (!host) return;
  host.innerHTML = `
    <header class="topbar">
      <div class="wrap topbar-inner">
        <a class="brand" href="index.html" aria-label="KORASTORE home">
          <img src="assets/logo.png" alt="" width="40" height="40">
          <span class="brand-text"><b>KORASTORE</b><small>Find it. Fund it. Own it.</small></span>
        </a>
        <nav class="nav" aria-label="Main">
          ${NAV.map(([href, label]) => `<a href="${href}" class="${active === href ? "on" : ""}">${label}${href === "cart.html" ? ` <span class="cart-count" id="cart-count">0</span>` : ""}</a>`).join("")}
        </nav>
      </div>
    </header>`;
  const paint = () => {
    const count = getCart().reduce((sum, i) => sum + i.quantity, 0);
    const el = document.querySelector("#cart-count");
    if (el) { el.textContent = count; el.hidden = count === 0; }
  };
  paint();
  window.addEventListener("korastore:cart", paint);
  window.addEventListener("storage", paint);
}

export function mountFooter() {
  const host = document.querySelector("#site-footer");
  if (!host) return;
  host.innerHTML = `
    <footer class="footer">
      <div class="wrap footer-inner">
        <div><b>KORASTORE</b><p>Find it. Fund it. Own it.</p></div>
        <div class="footer-links"><a href="shop.html">Shop</a><a href="wallet.html">Fund wallet</a><a href="orders.html">Orders</a><a href="mailto:beniwealth70@gmail.com">Contact</a></div>
        <small>© ${new Date().getFullYear()} KORASTORE</small>
      </div>
    </footer>`;
}

const ACCOUNT_TABS = [
  ["dashboard.html", "Overview"],
  ["wallet.html", "Fund wallet"],
  ["orders.html", "Orders"],
  ["profile.html", "Delivery location"]
];

export function mountAccountTabs(active) {
  const host = document.querySelector("#account-tabs");
  if (!host) return;
  host.innerHTML = `<nav class="tabs" aria-label="Account">${ACCOUNT_TABS.map(([href, label]) =>
    `<a href="${href}" class="${active === href ? "on" : ""}">${label}</a>`).join("")}<button type="button" class="tab-signout" data-signout>Sign out</button></nav>`;
}

// Waits for Firebase auth; redirects to login when signed out. Resolves with the user.
export function requireCustomer(nextPage) {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      if (!user) {
        location.replace(`login.html?next=${encodeURIComponent(nextPage)}`);
        return;
      }
      document.querySelectorAll("[data-signout]").forEach((button) => {
        button.addEventListener("click", async () => { await signOut(auth); location.replace("index.html"); });
      });
      resolve(user);
    });
  });
}

// Admin gate: only the configured admin email with a fresh `admin` claim gets through.
export function requireAdmin(activePage, gateSelector = "#gate", contentSelector = "#admin-content") {
  return new Promise((resolve) => {
    const gate = document.querySelector(gateSelector);
    const content = document.querySelector(contentSelector);
    const deny = (title, detail) => {
      if (gate) { gate.hidden = false; gate.innerHTML = `<div class="gate-card"><span class="gate-mark">!</span><h2>${esc(title)}</h2><p>${esc(detail)}</p><a class="btn" href="index.html">Back to store</a></div>`; }
    };
    const stop = onAuthStateChanged(auth, async (user) => {
      stop();
      if (!user) { location.replace(`login.html?next=${encodeURIComponent(activePage)}`); resolve(null); return; }
      if ((user.email || "").toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
        deny("Admins only", "This area is restricted to the KORASTORE administrator.");
        resolve(null);
        return;
      }
      let claims;
      try { claims = (await user.getIdTokenResult(true)).claims; } catch { claims = {}; }
      if (claims.admin !== true) {
        deny("Admin access not enabled yet", "The administrator needs the admin custom claim from the trusted setup, then a fresh sign-in.");
        resolve(null);
        return;
      }
      if (gate) gate.hidden = true;
      if (content) content.hidden = false;
      document.querySelectorAll("[data-signout]").forEach((button) => {
        button.addEventListener("click", async () => { await signOut(auth); location.replace("index.html"); });
      });
      resolve(user);
    });
  });
}

const ADMIN_LINKS = [
  ["admin.html", "Overview", "◎"],
  ["admin-products.html", "Products", "▣"],
  ["admin-funding.html", "Funding", "＋"],
  ["admin-orders.html", "Orders", "▤"],
  ["admin-settings.html", "Bank details", "⌂"]
];

export function mountAdminSidebar(active) {
  const host = document.querySelector("#admin-sidebar");
  if (!host) return;
  host.innerHTML = `
    <a class="brand" href="admin.html"><img src="assets/logo.png" alt="" width="36" height="36"><span class="brand-text"><b>KORASTORE</b><small>Admin console</small></span></a>
    <nav class="admin-nav" aria-label="Admin">
      ${ADMIN_LINKS.map(([href, label, icon]) => `<a href="${href}" class="${href === active ? "on" : ""}"><span aria-hidden="true">${icon}</span>${label}</a>`).join("")}
    </nav>
    <div class="admin-foot"><a href="index.html">View storefront ↗</a><button type="button" data-signout>Sign out</button></div>`;
}

// ---------- Product presentation ----------
const TONES = [
  "linear-gradient(135deg,#f2a900,#ff7a1a)",
  "linear-gradient(135deg,#1d4478,#2a7fba)",
  "linear-gradient(135deg,#0b2545,#5b3e9b)",
  "linear-gradient(135deg,#137a4a,#29b58a)",
  "linear-gradient(135deg,#8a1c3b,#e0556b)",
  "linear-gradient(135deg,#13315c,#0b2545)"
];
function toneFor(text) {
  let hash = 0;
  for (const char of String(text)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}
const safeImage = (url) => /^https:\/\/[^\s"'<>]+$/.test(String(url || "")) ? String(url) : "";

export function productMedia(product, extraClass = "") {
  const tone = `--tone:${toneFor(product.id || product.name)}`;
  const image = safeImage(product.imageUrl);
  return `<div class="product-media ${extraClass}" style="${tone}">${image
    ? `<img src="${esc(image)}" alt="${esc(product.name)}" loading="lazy">`
    : `<span class="mono-mark" aria-hidden="true">${esc(initials(product.name).slice(0, 2))}</span>`}</div>`;
}

export function stockBadge(product) {
  const stock = Number(product.stock || 0);
  if (stock <= 0) return `<span class="badge bad stock-tag">Out of stock</span>`;
  if (stock <= 5) return `<span class="badge wait stock-tag">Only ${stock} left</span>`;
  return `<span class="badge ok stock-tag">In stock</span>`;
}

export function productCard(product) {
  const out = Number(product.stock || 0) <= 0;
  return `
    <article class="product">
      <a href="product.html?id=${encodeURIComponent(product.id)}" aria-label="View ${esc(product.name)}">${productMedia(product)}${stockBadge(product)}</a>
      <div class="product-body">
        <span class="product-cat">${esc(product.category || "Store")}</span>
        <a class="product-name" href="product.html?id=${encodeURIComponent(product.id)}">${esc(product.name)}</a>
        <div class="product-price">${naira(product.price)}</div>
        <div class="product-actions">
          <button class="btn btn-sm btn-gold" data-add="${esc(product.id)}" ${out ? "disabled" : ""}>${out ? "Sold out" : "Add to cart"}</button>
          <a class="btn btn-sm btn-ghost" href="product.html?id=${encodeURIComponent(product.id)}">View</a>
        </div>
      </div>
    </article>`;
}

// One delegated handler for every "Add to cart" button on the page.
export function bindAddToCart(root = document) {
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-add]");
    if (!button || button.disabled) return;
    addToCart(button.dataset.add, 1);
    const original = button.textContent;
    button.textContent = "Added ✓";
    setTimeout(() => { button.textContent = original; }, 1100);
  });
}

export function readParam(name) {
  return new URLSearchParams(location.search).get(name) || "";
}

// ---------- Admin actions (executed by the Worker, which checks the admin token) ----------
export const reviewFunding = (requestId, decision) => apiPost("/admin/funding/review", { requestId, decision });
export const setOrderStatus = (orderId, status) => apiPost("/admin/orders/status", { orderId, status });
export const NEXT_ORDER_ACTIONS = {
  paid: [["processing", "Start packing"], ["cancelled", "Cancel & refund"]],
  processing: [["shipped", "Mark shipped"], ["cancelled", "Cancel & refund"]],
  shipped: [["delivered", "Mark delivered"]],
  delivered: [],
  cancelled: []
};
