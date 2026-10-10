// KORASTORE shared client: Firebase Auth/Firestore, checkout and admin transactions, cart, formatting and page shells.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, collection, query, where,
  orderBy, limit, onSnapshot, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAILS } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
export { signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut, sendEmailVerification };

// Tiny service worker so browser notifications can also fire on mobile (showNotification).
if (typeof navigator !== "undefined" && "serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

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

// The admin-chosen product ID is the Firestore document id, so every product has a stable
// id that appears in its link: product.html?id=<productId>.
export const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;

export function saveProduct(productId, data, { isNew = false } = {}) {
  if (typeof productId !== "string" || !PRODUCT_ID_PATTERN.test(productId)) {
    throw new Error("Product ID must be 3–40 letters, numbers, dashes or underscores.");
  }
  const payload = { ...data, updatedAt: serverTimestamp() };
  if (isNew) return setDoc(doc(db, "products", productId), { ...payload, sold: 0, createdAt: serverTimestamp() });
  return updateDoc(doc(db, "products", productId), payload);
}

export function watchPaymentSettings(callback, onError = noop) {
  return onSnapshot(doc(db, "settings", "payment"), (snap) => callback(snap.exists() ? snap.data() : null), onError);
}

export function savePaymentSettings(data) {
  return setDoc(doc(db, "settings", "payment"), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

// ---------- Checkout fees ----------
// Platform service fee and delivery fees added to every order. Defaults match the store
// policy; the admin can adjust them (and which state counts as "local") in admin-settings.
export const DEFAULT_FEES = { serviceFee: 2000, deliveryLocal: 2500, deliveryNigeria: 6000, localState: "Lagos" };

export function watchFeeSettings(callback, onError = noop) {
  return onSnapshot(doc(db, "settings", "fees"),
    (snap) => callback({ ...DEFAULT_FEES, ...(snap.exists() ? snap.data() : {}) }), onError);
}

export function saveFeeSettings(data) {
  return setDoc(doc(db, "settings", "fees"), {
    serviceFee: Math.round(Number(data.serviceFee ?? DEFAULT_FEES.serviceFee)),
    deliveryLocal: Math.round(Number(data.deliveryLocal ?? DEFAULT_FEES.deliveryLocal)),
    deliveryNigeria: Math.round(Number(data.deliveryNigeria ?? DEFAULT_FEES.deliveryNigeria)),
    localState: String(data.localState || DEFAULT_FEES.localState).slice(0, 60),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function getFeeSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "fees"));
    return { ...DEFAULT_FEES, ...(snap.exists() ? snap.data() : {}) };
  } catch {
    return { ...DEFAULT_FEES };
  }
}

// Splits a basket into subtotal + platform service fee + delivery fee.
// Delivery is the cheaper local rate only inside the store's local state; everywhere
// else in Nigeria (and abroad) uses the nationwide rate.
export function checkoutFees(subtotal, delivery, fees = DEFAULT_FEES) {
  const items = Math.round(Number(subtotal) || 0);
  const serviceFee = Math.max(0, Math.round(Number(fees.serviceFee) || 0));
  const country = String(delivery?.country || "").trim();
  const state = String(delivery?.state || "").trim();
  const localState = String(fees.localState || DEFAULT_FEES.localState).trim();
  const local = country === "Nigeria" && state === localState && !!state;
  const deliveryFee = Math.max(0, Math.round(Number(local ? fees.deliveryLocal : fees.deliveryNigeria) || 0));
  return {
    subtotal: items,
    serviceFee,
    deliveryFee,
    deliveryLabel: local ? `Delivery · ${localState}` : (country === "Nigeria" ? "Delivery · Nigeria" : (country ? "Delivery · outside Nigeria" : "Delivery")),
    total: items + serviceFee + deliveryFee
  };
}

// ---------- Recommended-product alerts ----------
// Written when the admin lists (or flags) a product as "recommended".
export function announceRecommended(productId, name) {
  return addDoc(collection(db, "notifications"), {
    type: "recommended",
    productId: String(productId),
    name: String(name || "New product").slice(0, 120),
    createdAt: serverTimestamp()
  });
}

export function watchNotifications(callback, onError = noop, max = 10) {
  return onSnapshot(query(collection(db, "notifications"), orderBy("createdAt", "desc"), limit(max)),
    (snap) => callback(rows(snap)), onError);
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

// Places an order: debits the wallet (items + service fee + delivery fee), decrements stock
// and writes the order, all in one transaction. Retrying with the same requestId returns
// the original order instead of charging twice.
export async function placeOrder(requestId, items) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to continue.");
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 80 || !ID_PATTERN.test(requestId)) {
    throw new Error("Request ID is invalid.");
  }
  const merged = new Map();
  for (const item of items || []) {
    const quantity = Number(item?.quantity);
    const productId = String(item?.productId || "");
    const size = String(item?.size || "").slice(0, 40);
    const color = String(item?.color || "").slice(0, 40);
    if (!productId || !ID_PATTERN.test(productId)) throw new Error("Product is invalid.");
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("Quantity must be a positive whole number.");
    }
    // Lines merge only when product AND variant match, so two sizes stay separate lines.
    const key = `${productId}|${size}|${color}`;
    const found = merged.get(key) || { productId, size, color, quantity: 0 };
    const combinedQuantity = found.quantity + quantity;
    if (!Number.isSafeInteger(combinedQuantity)) {
      throw new Error("The combined quantity is too large.");
    }
    found.quantity = combinedQuantity;
    merged.set(key, found);
  }
  if (merged.size === 0) throw new Error("Your cart is empty.");
  if (merged.size > MAX_CART_LINES) {
    throw new Error(`An order can have up to ${MAX_CART_LINES} cart lines. Remove some items from your cart.`);
  }

  const uid = user.uid;
  const orderId = `${uid}_${requestId}`;
  const orderRef = doc(db, "orders", orderId);
  const userRef = doc(db, "users", uid);
  const fees = await getFeeSettings();

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
    let subtotal = 0;
    for (const entry of merged.values()) {
      const productRef = doc(db, "products", entry.productId);
      const productSnap = await tx.get(productRef);
      const product = productSnap.exists() ? productSnap.data() : null;
      if (!product || product.active !== true) {
        throw new Error("An item in your order is no longer available. Review your cart.");
      }
      const variantPrices = Array.isArray(product.variantPrices) ? product.variantPrices : [];
      const variantIndex = variantPrices.findIndex(v => String(v?.size || '') === entry.size && String(v?.color || '') === entry.color);
      const price = Number(variantIndex >= 0 ? variantPrices[variantIndex].price : product.price);
      const stock = Number(product.stock || 0);
      if (!Number.isInteger(price) || price <= 0) throw new Error(`${product.name} has no valid price.`);
      if (stock < entry.quantity) {
        throw new Error(stock > 0 ? `Only ${stock} left of ${product.name}.` : `${product.name} is out of stock.`);
      }
      // Clothing variants must be one of the sizes/colours the admin listed.
      const sizes = Array.isArray(product.sizes) ? product.sizes.map(String) : [];
      const colors = Array.isArray(product.colors) ? product.colors.map(String) : [];
      if (entry.size && !sizes.includes(entry.size)) throw new Error(`Size ${entry.size} is not available for ${product.name}.`);
      if (entry.color && !colors.includes(entry.color)) throw new Error(`Colour ${entry.color} is not available for ${product.name}.`);
      if (variantPrices.length && variantIndex < 0) throw new Error(`The selected option is not available for ${product.name}.`);
      const minimum = Math.max(1, Number(product.minOrderQuantity || 1));
      if (entry.quantity < minimum) throw new Error(`${product.name} has a minimum order of ${minimum}.`);
      const lineTotal = price * entry.quantity;
      subtotal += lineTotal;
      lines.push({
        productId: entry.productId, name: String(product.name || "Product"), price,
        quantity: entry.quantity, lineTotal, size: entry.size, color: entry.color, variantIndex
      });
      stockChanges.push({ ref: productRef, stock, sold: Number(product.sold || 0), quantity: entry.quantity });
    }

    const feeParts = checkoutFees(subtotal, delivery, fees);
    const total = feeParts.total;
    const balance = Number(profile.balance || 0);
    if (balance < total) {
      throw new Error(`Your wallet has ${naira(balance)} but this order costs ${naira(total)} (items + fees). Fund your wallet first.`);
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
      uid, requestId, items: lines,
      subtotal: feeParts.subtotal, serviceFee: feeParts.serviceFee, deliveryFee: feeParts.deliveryFee,
      total, status: "paid", delivery,
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
    return {
      orderId, status: "paid",
      subtotal: feeParts.subtotal, serviceFee: feeParts.serviceFee, deliveryFee: feeParts.deliveryFee,
      total, balance: newBalance, duplicate: false
    };
  });
}

export const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ---------- Cart (kept on this device; checkout re-prices everything from the database) ----------
const CART_KEY = "korastore-cart";
const cleanVariant = (value) => String(value || "").trim().slice(0, 40);
export function getCart() {
  try {
    const items = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    return Array.isArray(items)
      ? items.filter((i) => i && typeof i.productId === "string"
          && Number.isSafeInteger(Number(i.quantity)) && Number(i.quantity) > 0).map((i) => ({
        productId: i.productId,
        quantity: Number(i.quantity),
        size: cleanVariant(i.size),
        color: cleanVariant(i.color)
      }))
      : [];
  } catch {
    return [];
  }
}
export function setCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent("korastore:cart"));
}
export function addToCart(productId, quantity = 1, variant = {}) {
  const amount = Number(quantity);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Quantity must be a positive whole number.");
  const items = getCart();
  const size = cleanVariant(variant.size);
  const color = cleanVariant(variant.color);
  const found = items.find((i) => i.productId === productId && i.size === size && i.color === color);
  if (found) {
    const combinedQuantity = found.quantity + amount;
    if (!Number.isSafeInteger(combinedQuantity)) throw new Error("The combined quantity is too large.");
    found.quantity = combinedQuantity;
  } else items.push({ productId, quantity: amount, size, color });
  setCart(items);
}

// ---------- Page shells ----------
let alertsStarted = false;
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
  // Every storefront page listens for new recommended products and notifies the user.
  if (!alertsStarted) { alertsStarted = true; watchRecommendedAlerts(); }
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

// Admin gate: matches firestore.rules — one of the configured admin emails with a
// verified email address. Security is enforced server-side by the rules; this is the same check.
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
      if (!ADMIN_EMAILS.includes((user.email || "").trim().toLowerCase())) {
        deny("Admins only", "This area is restricted to approved KORASTORE administrators.");
        resolve(null);
        return;
      }
      try { await user.reload(); } catch { /* fall back to cached profile */ }
      if (!user.emailVerified) {
        deny("Verify your email first", "Administrator accounts must have a verified email address. Check your inbox for the verification link, then sign in again.");
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
  ["admin-fees.html", "Checkout fees", "₦"],
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
// Product images are base64 data URLs stored in Firestore (admin uploads), with an
// https:// URL accepted as a legacy fallback. Anything else is ignored.
const DATA_IMAGE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const safeImage = (url) => {
  const value = String(url || "");
  return (/^https:\/\/[^\s"'<>]+$/.test(value) || DATA_IMAGE.test(value)) ? value : "";
};
export function productImages(product) {
  return (Array.isArray(product?.images) ? product.images.map(safeImage) : []).filter(Boolean);
}
export function productMedia(product, extraClass = "", index = 0) {
  const tone = `--tone:${toneFor(product.id || product.name)}`;
  const images = productImages(product);
  const image = images[index] || safeImage(product.imageUrl);
  return `<div class="product-media ${extraClass}" style="${tone}">${image
    ? `<img src="${esc(image)}" alt="${esc(product.name)}" loading="lazy">`
    : `<span class="mono-mark" aria-hidden="true">${esc(initials(product.name).slice(0, 2))}</span>`}</div>`;
}

// Returns the admin-set price for a chosen size/colour, or the base price.
export function productPrice(product, variant = {}) {
  const options = Array.isArray(product?.variantPrices) ? product.variantPrices : [];
  const match = options.find(v => String(v?.size || '') === String(variant.size || '') && String(v?.color || '') === String(variant.color || ''));
  return Math.round(Number(match?.price ?? product?.price) || 0);
}

// Selling price, with the original price slashed through when a discount is set.
export function priceHTML(product, extraClass = "product-price") {
  const optionPrices = (Array.isArray(product?.variantPrices) ? product.variantPrices : []).map(v => Math.round(Number(v.price) || 0)).filter(v => v > 0);
  const price = optionPrices.length ? Math.min(...optionPrices) : Math.round(Number(product?.price) || 0);
  const high = optionPrices.length ? Math.max(...optionPrices) : price;
  const compare = Math.round(Number(product?.compareAtPrice) || 0);
  const discounted = compare > price;
  const off = discounted ? Math.round((1 - price / compare) * 100) : 0;
  return `<div class="${extraClass}"><span>${high > price ? `${naira(price)} – ${naira(high)}` : naira(price)}</span>${discounted
    ? ` <s class="price-was">${naira(compare)}</s> <span class="price-off">−${off}%</span>` : ""}</div>`;
}

export const hasVariants = (product) =>
  Boolean((Array.isArray(product?.sizes) && product.sizes.length) || (Array.isArray(product?.colors) && product.colors.length));

export function variantLabel(item) {
  return [item?.size, item?.color].filter(Boolean).join(" · ");
}

export function stockBadge(product) {
  const stock = Number(product.stock || 0);
  const minimum = Math.max(1, Number(product.minOrderQuantity || 1));
  if (stock <= 0) return `<span class="badge bad stock-tag">Out of stock</span>`;
  if (stock < minimum) return `<span class="badge bad stock-tag">Below minimum order</span>`;
  if (stock <= 5) return `<span class="badge wait stock-tag">Only ${stock} left</span>`;
  return `<span class="badge ok stock-tag">In stock</span>`;
}

export function productCard(product) {
  const stock = Number(product.stock || 0);
  const minimum = Math.max(1, Number(product.minOrderQuantity || 1));
  const out = stock < minimum;
  const link = `product.html?id=${encodeURIComponent(product.id)}`;
  return `
    <article class="product">
      <a href="${link}" aria-label="View ${esc(product.name)}">${productMedia(product)}${stockBadge(product)}${product.recommended ? '<span class="badge gold rec-tag">★ Recommended</span>' : ""}</a>
      <div class="product-body">
        <span class="product-cat">${esc(product.category || "Store")}</span>
        <a class="product-name" href="${link}">${esc(product.name)}</a>
        ${priceHTML(product)}
        <div class="product-actions">
          ${hasVariants(product)
    ? `<a class="btn btn-sm btn-gold" href="${link}">Choose options</a>`
    : `<button class="btn btn-sm btn-gold" data-add="${esc(product.id)}" data-min="${minimum}" ${out ? "disabled" : ""}>${out ? (stock <= 0 ? "Sold out" : "Unavailable") : "Add to cart"}</button>`}
          <a class="btn btn-sm btn-ghost" href="${link}">View</a>
        </div>
      </div>
    </article>`;
}

// One delegated handler for every "Add to cart" button on the page.
export function bindAddToCart(root = document) {
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-add]");
    if (!button || button.disabled) return;
    addToCart(button.dataset.add, Number(button.dataset.min || 1));
    const original = button.textContent;
    button.textContent = "Added ✓";
    setTimeout(() => { button.textContent = original; }, 1100);
  });
}

export function readParam(name) {
  return new URLSearchParams(location.search).get(name) || "";
}

// ---------- Browser notifications ----------
// Best-effort: a real browser notification when permission is granted (with a service
// worker fallback on mobile), and always an in-page toast so nothing is silently lost.
const NOTIFIED_KEY = "korastore-notified-at";

export function notificationState() {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export async function requestNotificationPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

export function showToast(title, text = "") {
  let host = document.querySelector("#toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    document.body.appendChild(host);
  }
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<div class="toast-body"><b>${esc(title)}</b>${text ? `<small>${esc(text)}</small>` : ""}</div><button class="toast-x" aria-label="Dismiss">×</button>`;
  toast.querySelector(".toast-x").addEventListener("click", () => toast.remove());
  host.appendChild(toast);
  setTimeout(() => toast.remove(), 8000);
}

export async function showBrowserNotification({ title, body, tag, icon = "assets/icon-512.png", link = "" }) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const options = { body: String(body || ""), tag: String(tag || "korastore"), icon };
  try {
    const note = new Notification(title, options);
    if (link) note.onclick = () => { window.open(link, "_blank"); note.close(); };
    return true;
  } catch {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) { await reg.showNotification(title, { ...options, data: { link } }); return true; }
    } catch { /* fall back to the in-page toast only */ }
  }
  return false;
}

// Notifies this browser about recommended products added since it last looked:
// live while a page is open, and a catch-up on the next visit. The first visit only
// records where the feed is, so a new visitor is not spammed with old items.
export function watchRecommendedAlerts() {
  let lastSeen = Number(localStorage.getItem(NOTIFIED_KEY) || 0);
  let baselineSet = lastSeen > 0;
  return watchNotifications((items) => {
    const fresh = items.filter((item) => (toDate(item.createdAt)?.getTime() || 0) > lastSeen);
    const newest = fresh.length ? Math.max(...fresh.map((i) => toDate(i.createdAt)?.getTime() || 0)) : lastSeen;
    if (!baselineSet) {
      baselineSet = true;
      lastSeen = newest;
      if (newest) localStorage.setItem(NOTIFIED_KEY, String(newest));
      return;
    }
    if (fresh.length) {
      for (const item of fresh.slice(0, 3).reverse()) {
        const link = item.productId ? `product.html?id=${encodeURIComponent(item.productId)}` : "shop.html";
        showToast("Recommended for you", `${item.name} just landed in the shop`);
        showBrowserNotification({
          title: "KORASTORE · Recommended for you",
          body: `${item.name} just landed in the shop`,
          tag: item.productId || item.id,
          link
        });
      }
      lastSeen = newest;
      localStorage.setItem(NOTIFIED_KEY, String(newest));
    }
  });
}

// ---------- Admin actions (run as one transaction each; firestore.rules allow them only for admins) ----------
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
