// KORASTORE shared client: Firebase Auth/Firestore, checkout and admin transactions, cart, formatting and page shells.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, collection, query, where,
  orderBy, limit, onSnapshot, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAIL } from "./firebase-config.js";

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

// ---------- Checkout and admin actions (Firestore transactions, enforced by firestore.rules) ----------
export const MAX_CART_LINES = 5;
export const MAX_QTY = 50;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
let locationsCache = null;

async function nigeriaLocations() {
  if (!locationsCache) {
    const response = await fetch("./data/ng-locations.json");
    locationsCache = await response.json();
  }
  return locationsCache;
}

// Checks the customer's saved delivery location.
async function validateDelivery(profile) {
  const country = String(profile.country || "").trim();
  const state = String(profile.state || "").trim();
  const lga = String(profile.lga || "").trim();
  const address = String(profile.address || "").trim();
  if (!country || !state || !address) {
    throw new Error("Add your delivery location (country, state, address) in your profile before buying.");
  }
  if (country === "Nigeria") {
    const entry = (await nigeriaLocations()).find((item) => item.state === state);
    if (!entry) throw new Error("Choose a valid Nigerian state in your profile.");
    if (!entry.lgas.includes(lga)) throw new Error("Choose your local government area in your profile.");
  }
  return { country, state, lga, address };
}

// Places an order: debits the wallet, decrements stock and writes the order, all in one transaction.
// Retrying with the same requestId returns the original order instead of charging twice.
export async function placeOrder(requestId, items) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to continue.");
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 80 || !ID_PATTERN.test(requestId)) {
    throw new Error("Request ID is invalid.");
  }
  const merged = new Map();
  for (const item of items || []) {
    const quantity = Number(item?.quantity);
    if (!item?.productId || !ID_PATTERN.test(item.productId)) throw new Error("Product is invalid.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      throw new Error(`Quantity must be a whole number from 1 to ${MAX_QTY}.`);
    }
    merged.set(item.productId, Math.min(MAX_QTY, (merged.get(item.productId) || 0) + quantity));
  }
  if (merged.size === 0) throw new Error("Your cart is empty.");
  if (merged.size > MAX_CART_LINES) {
    throw new Error(`An order can have up to ${MAX_CART_LINES} different products. Remove some items from your cart.`);
  }

  const uid = user.uid;
  const orderId = `${uid}_${requestId}`;
  const orderRef = doc(db, "orders", orderId);
  const userRef = doc(db, "users", uid);

  return runTransaction(db, async (tx) => {
    const existing = await tx.get(orderRef);
    if (existing.exists()) {
      const order = existing.data();
      return { orderId, status: order.status, total: order.total, duplicate: true };
    }

    const profileSnap = await tx.get(userRef);
    if (!profileSnap.exists()) throw new Error("Your profile is not ready yet. Sign out and back in.");
    const profile = profileSnap.data();
    const delivery = await validateDelivery(profile);

    const lines = [];
    const stockChanges = [];
    let total = 0;
    for (const [productId, quantity] of merged) {
      const productRef = doc(db, "products", productId);
      const productSnap = await tx.get(productRef);
      const product = productSnap.exists() ? productSnap.data() : null;
      if (!product || product.active !== true) {
        throw new Error("An item in your order is no longer available. Review your cart.");
      }
      const price = Number(product.price);
      const stock = Number(product.stock || 0);
      if (!Number.isInteger(price) || price <= 0) throw new Error(`${product.name} has no valid price.`);
      if (stock < quantity) {
        throw new Error(stock > 0 ? `Only ${stock} left of ${product.name}.` : `${product.name} is out of stock.`);
      }
      const lineTotal = price * quantity;
      total += lineTotal;
      lines.push({ productId, name: String(product.name || "Product"), price, quantity, lineTotal });
      stockChanges.push({ ref: productRef, stock, sold: Number(product.sold || 0), quantity });
    }

    const balance = Number(profile.balance || 0);
    if (balance < total) {
      throw new Error(`Your wallet has ${naira(balance)} but this order costs ${naira(total)}. Fund your wallet first.`);
    }
    const newBalance = balance - total;

    tx.update(userRef, { balance: newBalance, lastOrderId: orderId, updatedAt: serverTimestamp() });
    for (const change of stockChanges) {
      tx.update(change.ref, {
        stock: change.stock - change.quantity,
        sold: change.sold + change.quantity,
        lastOrderId: orderId,
        updatedAt: serverTimestamp()
      });
    }
    tx.set(orderRef, {
      uid, requestId, items: lines, total, status: "paid", delivery,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    tx.set(doc(db, "users", uid, "transactions", `purchase_${orderId}`), {
      type: "purchase", title: `Order ${orderId.slice(-6).toUpperCase()}`, amount: -total,
      status: "paid", orderId, balanceAfter: newBalance, createdAt: serverTimestamp()
    });
    tx.set(doc(db, "ledger", `purchase_${orderId}`), {
      type: "purchase", uid, amount: -total, balanceAfter: newBalance,
      reference: orderId, actor: uid, createdAt: serverTimestamp()
    });
    return { orderId, status: "paid", total, balance: newBalance, duplicate: false };
  });
}

export const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ---------- Cart (kept on this device; checkout re-prices everything from the database) ----------
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

// Admin gate: matches firestore.rules — the configured admin email with a verified
// email address. Security is enforced server-side by the rules; this is the same check.
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
      try { await user.reload(); } catch { /* fall back to cached profile */ }
      if (!user.emailVerified) {
        deny("Verify your email first", "The admin account must have a verified email address. Check your inbox for the verification link, then sign in again.");
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

// ---------- Admin actions (run as one transaction each; firestore.rules allow them only for the admin) ----------
export async function reviewFunding(requestId, decision) {
  if (decision !== "approve" && decision !== "reject") throw new Error("Decision must be approve or reject.");
  const admin = auth.currentUser?.email || "admin";
  const requestRef = doc(db, "fundingRequests", requestId);

  return runTransaction(db, async (tx) => {
    const requestSnap = await tx.get(requestRef);
    if (!requestSnap.exists()) throw new Error("Funding request not found.");
    const request = requestSnap.data();
    if (request.status !== "pending") throw new Error(`This request has already been ${request.status}.`);

    if (decision === "reject") {
      tx.update(requestRef, { status: "rejected", reviewedAt: serverTimestamp(), reviewedBy: admin });
      return { requestId, status: "rejected" };
    }

    const amount = Number(request.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("The request amount is invalid.");
    const userRef = doc(db, "users", request.uid);
    const profileSnap = await tx.get(userRef);
    if (!profileSnap.exists()) throw new Error("The customer profile for this request does not exist.");
    const newBalance = Number(profileSnap.data().balance || 0) + amount;

    tx.update(userRef, { balance: newBalance, updatedAt: serverTimestamp() });
    tx.update(requestRef, { status: "approved", reviewedAt: serverTimestamp(), reviewedBy: admin });
    tx.set(doc(db, "users", request.uid, "transactions", `funding_${requestId}`), {
      type: "funding", title: `Wallet funded · ${String(request.reference || "bank transfer").slice(0, 60)}`,
      amount, status: "approved", requestId, balanceAfter: newBalance, createdAt: serverTimestamp()
    });
    tx.set(doc(db, "ledger", `funding_${requestId}`), {
      type: "funding", uid: request.uid, amount, balanceAfter: newBalance,
      reference: requestId, actor: admin, createdAt: serverTimestamp()
    });
    return { requestId, status: "approved", balance: newBalance };
  });
}

const ORDER_TRANSITIONS = {
  paid: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: []
};

// Moves an order forward. Cancelling also refunds the total to the wallet and restocks every line.
export async function setOrderStatus(orderId, status) {
  if (!["processing", "shipped", "delivered", "cancelled"].includes(status)) {
    throw new Error("Status must be processing, shipped, delivered or cancelled.");
  }
  const admin = auth.currentUser?.email || "admin";
  const orderRef = doc(db, "orders", orderId);

  return runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Order not found.");
    const order = orderSnap.data();
    if (!ORDER_TRANSITIONS[order.status]?.includes(status)) {
      throw new Error(`An order that is ${order.status} cannot be changed to ${status}.`);
    }

    if (status !== "cancelled") {
      tx.update(orderRef, { status, updatedAt: serverTimestamp() });
      return { orderId, status };
    }

    const refund = Number(order.total || 0);
    const userRef = doc(db, "users", order.uid);
    const profileSnap = await tx.get(userRef);
    if (!profileSnap.exists()) throw new Error("The customer profile for this order does not exist.");
    const newBalance = Number(profileSnap.data().balance || 0) + refund;

    const restock = [];
    for (const item of order.items || []) {
      const productRef = doc(db, "products", item.productId);
      const productSnap = await tx.get(productRef);
      if (productSnap.exists()) restock.push({ ref: productRef, product: productSnap.data(), quantity: Number(item.quantity || 0) });
    }

    tx.update(userRef, { balance: newBalance, updatedAt: serverTimestamp() });
    tx.update(orderRef, { status: "cancelled", cancelledAt: serverTimestamp(), updatedAt: serverTimestamp() });
    for (const change of restock) {
      tx.update(change.ref, {
        stock: Number(change.product.stock || 0) + change.quantity,
        sold: Math.max(0, Number(change.product.sold || 0) - change.quantity),
        updatedAt: serverTimestamp()
      });
    }
    tx.set(doc(db, "users", order.uid, "transactions", `refund_${orderId}`), {
      type: "refund", title: `Refund · Order ${orderId.slice(-6).toUpperCase()}`, amount: refund,
      status: "refunded", orderId, balanceAfter: newBalance, createdAt: serverTimestamp()
    });
    tx.set(doc(db, "ledger", `refund_${orderId}`), {
      type: "refund", uid: order.uid, amount: refund, balanceAfter: newBalance,
      reference: orderId, actor: admin, createdAt: serverTimestamp()
    });
    return { orderId, status: "cancelled", refunded: refund, balance: newBalance };
  });
}

export const NEXT_ORDER_ACTIONS = {
  paid: [["processing", "Start packing"], ["cancelled", "Cancel & refund"]],
  processing: [["shipped", "Mark shipped"], ["cancelled", "Cancel & refund"]],
  shipped: [["delivered", "Mark delivered"]],
  delivered: [],
  cancelled: []
};
