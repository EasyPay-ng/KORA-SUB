// KORASTORE shared client: Firebase Auth/Firestore, checkout and admin transactions, cart, formatting and page shells.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, collection, query, where,
  orderBy, limit, onSnapshot, serverTimestamp, runTransaction, writeBatch, increment
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAILS } from "./firebase-config.js";
import { ONESIGNAL_APP_ID } from "./push-config.js";
import {
  ESIM_PLAN_ID_PATTERN, ESIM_MAX_QUANTITY, esimOrderTotal, validatePlanDraft, validityLabel
} from "./esim-catalogue.mjs";

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

// Saves (or clears, with null) the pickup station this customer orders to. Stored on the
// profile so checkout and fulfilment always show the station they last chose.
export async function savePickupStation(uid, station) {
  await updateDoc(doc(db, "users", uid), {
    pickup: station
      ? {
        stationId: String(station.id || ""),
        stationName: String(station.name || ""),
        state: String(station.state || ""),
        address: String(station.address || ""),
        landmark: String(station.landmark || "")
      }
      : null,
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
// The platform service fee is known at checkout. Shipping is deliberately not part of
// this schedule: the admin chooses it per order after seeing the customer's pickup
// station and fulfilment details.
export const DEFAULT_FEES = { serviceFee: 2000 };

export function watchFeeSettings(callback, onError = noop) {
  return onSnapshot(doc(db, "settings", "fees"),
    (snap) => callback({ ...DEFAULT_FEES, ...(snap.exists() ? snap.data() : {}) }), onError);
}

export function saveFeeSettings(data) {
  return setDoc(doc(db, "settings", "fees"), {
    serviceFee: Math.round(Number(data.serviceFee ?? DEFAULT_FEES.serviceFee)),
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

// Splits a basket into the amount known at checkout. Shipping stays blank until an
// administrator sets it on the order; the customer is notified with the final
// subtotal + service fee + shipping breakdown at that point.
export function checkoutFees(subtotal, delivery, fees = DEFAULT_FEES) {
  const items = Math.round(Number(subtotal) || 0);
  const serviceFee = Math.max(0, Math.round(Number(fees.serviceFee) || 0));
  const state = String(delivery?.state || "").trim();
  return {
    subtotal: items,
    serviceFee,
    shippingFee: null,
    shippingLabel: state ? `Shipping · ${state} · Set by store` : "Shipping fee · Set by store",
    total: items + serviceFee
  };
}

// ---------- Recommended-product alerts ----------
// Written when the admin lists (or flags) a product as "recommended". This feed drives the
// in-browser alerts. Closed-browser push is sent from the OneSignal dashboard (see README).
export function announceRecommended(productId, name) {
  return addDoc(collection(db, "notifications"), {
    type: "recommended",
    productId: String(productId),
    name: String(name || "New product").slice(0, 120),
    createdAt: serverTimestamp()
  });
}

// ---------- OneSignal (closed-browser push for shoppers) ----------
// Loads the OneSignal web SDK once. It uses sw.js (which imports OneSignal's worker) so
// there is still a single service worker for the site. Nothing loads when the App ID is empty.
let oneSignalStarted = false;
export function startOneSignal() {
  if (!ONESIGNAL_APP_ID || oneSignalStarted || location.protocol === "file:") return;
  oneSignalStarted = true;
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(async (OneSignal) => {
    await OneSignal.init({
      appId: ONESIGNAL_APP_ID,
      serviceWorkerPath: new URL("sw.js", document.baseURI).pathname,
      serviceWorkerParam: { scope: new URL("./", document.baseURI).pathname },
      allowLocalhostAsSecureOrigin: true
    });
  });
  const script = document.createElement("script");
  script.src = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
  script.defer = true;
  document.head.appendChild(script);
}

// The shopper's "Turn on alerts" button. With OneSignal on, the prompt also subscribes the
// browser for closed-browser push. Without it, this is the plain browser prompt.
export async function requestShopperAlerts() {
  if (!ONESIGNAL_APP_ID) return requestNotificationPermission();
  startOneSignal();
  const asked = new Promise((resolve) => {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async (OneSignal) => {
      try { await OneSignal.Notifications.requestPermission(); } catch { /* the state below still tells the truth */ }
      resolve();
    });
  });
  // If the OneSignal script is blocked, do not leave the button stuck on "Asking…".
  await Promise.race([asked, new Promise((resolve) => setTimeout(resolve, 15000))]);
  return notificationState();
}

export function watchNotifications(callback, onError = noop, max = 10) {
  return onSnapshot(query(collection(db, "notifications"), orderBy("createdAt", "desc"), limit(max)),
    (snap) => callback(rows(snap)), onError);
}

// Private account notifications are used for order-specific updates. They are separate
// from the public recommended-product feed so a customer's shipping amount is never
// exposed to another signed-in user.
export function watchMyNotifications(uid, callback, onError = noop, max = 10) {
  return onSnapshot(
    query(collection(db, "users", uid, "notifications"), orderBy("createdAt", "desc"), limit(max)),
    (snap) => callback(rows(snap)), onError
  );
}

export function shippingBreakdown(data) {
  const orderId = String(data?.orderId || "");
  const reference = orderId ? orderId.slice(-8).toUpperCase() : "—";
  const subtotal = naira(data?.subtotal || 0);
  const serviceFee = naira(data?.serviceFee || 0);
  const shippingFee = naira(data?.shippingFee || 0);
  const total = naira(data?.total || 0);
  const due = Number(data?.amountDue || 0);
  return `Order ${reference}: items ${subtotal} + service ${serviceFee} + shipping ${shippingFee} = total ${total}${due > 0 ? `. Pay ${naira(due)} shipping from your wallet to complete payment.` : ". No amount is due."}`;
}

const CUSTOMER_SHIPPING_SEEN_PREFIX = "korastore-shipping-seen-";
let customerShippingAlertsStarted = false;

// Watches private shipping updates on every storefront page. Firestore listeners make
// the alert live while the customer is online; the timestamp stored in localStorage also
// lets the next visit catch up on a fee that was set while the browser was closed.
export function startCustomerShippingAlerts() {
  if (customerShippingAlertsStarted) return;
  customerShippingAlertsStarted = true;
  let stop = null;
  onAuthStateChanged(auth, (user) => {
    if (stop) { stop(); stop = null; }
    if (!user) return;
    const seenKey = `${CUSTOMER_SHIPPING_SEEN_PREFIX}${user.uid}`;
    let lastSeen = Number(localStorage.getItem(seenKey) || 0);
    stop = watchMyNotifications(user.uid, (items) => {
      const shipping = items
        .filter((item) => item.type === "shipping_fee")
        .map((item) => ({ ...item, time: toDate(item.updatedAt || item.createdAt)?.getTime() || 0 }))
        .filter((item) => item.time > lastSeen)
        .sort((a, b) => a.time - b.time);
      if (!shipping.length) return;
      lastSeen = shipping.reduce((max, item) => Math.max(max, item.time), lastSeen);
      localStorage.setItem(seenKey, String(lastSeen));
      for (const item of shipping.slice(-5)) {
        const body = shippingBreakdown(item);
        showToast("Shipping fee set", body);
        showBrowserNotification({
          title: "KORASTORE · Shipping fee set",
          body,
          tag: `shipping-${item.orderId}`,
          link: new URL("orders.html", location.href).href
        });
      }
    }, noop);
  });
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

// ---------- Pickup stations ----------
// Orders are collected at a pickup station instead of a doorstep address: the customer
// picks their state, then the station closest to them. The catalogue lives in Firestore
// — pickupStations/{stationId}, seeded from data/jumia-pickup-stations.json by
// Admin → Pickup stations — so the security rules can pin an order to a real station
// (and the admin can review the station before setting that order's shipping fee).
export const PICKUP_COUNTRY = "Nigeria";
const PICKUP_META = ["settings", "pickupStations"];

// The tiny catalogue summary the admin publish writes: { states: [{state, stations}],
// total, updatedAt }. Everyone can read it; it drives the state dropdown.
export function watchPickupCatalog(callback, onError = noop) {
  return onSnapshot(doc(db, ...PICKUP_META), (snap) => callback(snap.exists() ? snap.data() : null), onError);
}

export async function fetchPickupCatalog() {
  const snap = await getDoc(doc(db, ...PICKUP_META));
  return snap.exists() ? snap.data() : null;
}

// Active stations in one state. Two equality filters need no composite index; sorting
// (by name, or by distance once the customer shares their location) happens here.
export async function fetchPickupStations(state) {
  const snap = await getDocs(query(
    collection(db, "pickupStations"),
    where("state", "==", String(state || "")),
    where("active", "==", true)
  ));
  return rows(snap);
}

// Every active station — used for "use my location", which finds the closest station
// nationally (someone near a state border may be closer to the next state's station).
export async function fetchAllPickupStations() {
  const snap = await getDocs(query(collection(db, "pickupStations"), where("active", "==", true)));
  return rows(snap);
}

// Every station, hidden ones included — the admin table.
export async function fetchEveryPickupStation() {
  const snap = await getDocs(collection(db, "pickupStations"));
  return rows(snap);
}

// Publishes the catalogue: upserts the stations given and hides the ids listed. Called
// from Admin → Pickup stations; the write is chunked into batches of 400 documents.
export async function publishPickupStations({ upserts = [], hideIds = [] } = {}) {
  const writes = [
    ...upserts.map((station) => ({ id: station.id, data: station.data })),
    ...hideIds.map((id) => ({ id, data: { active: false } }))
  ];
  for (let start = 0; start < writes.length; start += 400) {
    const batch = writeBatch(db);
    for (const write of writes.slice(start, start + 400)) {
      batch.set(doc(db, "pickupStations", write.id), { ...write.data, updatedAt: serverTimestamp() }, { merge: true });
    }
    await batch.commit();
  }
  return writes.length;
}

// Saves the catalogue summary (the state list for the picker and admin counts).
export function savePickupCatalog({ states = [], total = 0 } = {}) {
  return setDoc(doc(db, ...PICKUP_META), {
    states: states.map((entry) => ({ state: String(entry.state || ""), stations: Number(entry.stations || 0) })),
    total: Number(total || 0),
    updatedAt: serverTimestamp()
  });
}

export function stationShortName(name, max = 40) {
  const text = String(name || "").trim();
  const short = text.replace(/^jumia\s+(pick[ -]?up|pickup)\s+stations?\s*/i, "").trim() || text;
  return short.slice(0, max);
}

export function stationDistanceLabel(station) {
  if (!station || station.distance == null) return "";
  return station.distance < 1
    ? `${Math.round(station.distance * 1000)} m away`
    : `${station.distance.toFixed(1)} km away`;
}

// Sorts stations by distance from a point when given, otherwise by name.
function orderStations(list, origin = null) {
  const withDistance = list.map((station) => ({
    ...station,
    distance: origin ? haversineKm(origin, station) : null,
    search: [station.name, station.address, station.landmark].filter(Boolean).join(" ").toLowerCase()
  }));
  withDistance.sort((a, b) => (a.distance == null || b.distance == null)
    ? String(a.name).localeCompare(String(b.name))
    : a.distance - b.distance);
  return withDistance;
}

// Great-circle distance in km between a {latitude, longitude} point and a station.
function haversineKm(point, station) {
  const lat1 = Number(point?.latitude);
  const lon1 = Number(point?.longitude);
  const lat2 = Number(station?.latitude);
  const lon2 = Number(station?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const radius = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// The pickup chooser used on the cart and the profile page. Renders a state dropdown, an
// optional "use my location" button, a search box and the station list for the chosen
// state; calls onSelect(station) whenever the customer picks one.
//
// Returns { refresh, focus, getSelected } so a page can resync it with the saved profile
// station (refresh), send the customer to it (focus) or read the current pick.
export function mountPickupPicker(host, { selectedId = "", onSelect = noop } = {}) {
  let catalog = null;
  let stations = [];
  let state = "";
  let origin = null;
  let needle = "";
  let selected = String(selectedId || "");
  let failure = "";
  // Serialises every async load: a slow reply can never overwrite a newer one, so the
  // state selector and the station list always agree.
  let sequence = 0;
  // The selection we last followed to its state. Ordinary refreshes never yank the
  // customer out of a state they are browsing — only a newly seen selection moves them.
  let followed = "";

  host.innerHTML = `
    <div class="pickup-tools">
      <label class="field">State<select class="select" data-pickup="state"><option value="">Loading…</option></select></label>
      <button class="btn btn-sm btn-ghost" type="button" data-pickup="locate">Use my location</button>
    </div>
    <input class="input" data-pickup="search" placeholder="Search station, area or landmark" style="margin:12px 0 6px" hidden>
    <div class="pickup-list" data-pickup="list"><div class="empty"><b>Loading pickup stations…</b></div></div>
    <div class="small muted" data-pickup="note" style="margin-top:8px"></div>`;

  const el = (what) => host.querySelector(`[data-pickup="${what}"]`);
  const listHost = el("list");
  const noteEl = el("note");
  const stateSelect = el("state");
  const searchInput = el("search");
  const locateButton = el("locate");

  const setNote = (text) => { noteEl.textContent = text || ""; };

  function renderStates() {
    const entries = (Array.isArray(catalog?.states) ? catalog.states : []).filter((entry) => entry && entry.state);
    stateSelect.innerHTML = '<option value="">Choose a state</option>'
      + entries.map((entry) => `<option value="${esc(entry.state)}">${esc(entry.state)} (${Number(entry.stations) || 0})</option>`).join('');
    stateSelect.disabled = !entries.length;
    syncStateSelect();
  }

  // The selector must always offer the state whose stations are listed, even when the
  // catalogue summary is stale and does not mention it (a station chosen via "use my
  // location", or a state the summary write missed).
  function syncStateSelect() {
    if (state && ![...stateSelect.options].some((option) => option.value === state)) {
      const option = document.createElement('option');
      option.value = state;
      option.textContent = state;
      stateSelect.appendChild(option);
      stateSelect.disabled = false;
    }
    if (stateSelect.value !== state) stateSelect.value = state;
  }

  function syncRows() {
    for (const row of host.querySelectorAll('.pickup-row')) {
      const input = row.querySelector('input');
      const on = Boolean(input) && input.value === selected;
      row.classList.toggle('on', on);
      if (input) input.checked = on;
    }
  }

  function renderList() {
    if (failure) {
      listHost.innerHTML = `<div class="empty"><b>Pickup stations unavailable</b><p class="small">${esc(failure)}</p></div>`;
      searchInput.hidden = true;
      return;
    }
    if (!catalog) {
      listHost.innerHTML = '<div class="empty"><b>No pickup stations yet</b><p class="small">The store has not published its station list. Try again later or contact the store.</p></div>';
      searchInput.hidden = true;
      return;
    }
    if (!state) {
      listHost.innerHTML = '<div class="empty"><b>Choose your state</b><p class="small">Every pickup station in your state will be listed here — pick the one closest to you.</p></div>';
      searchInput.hidden = true;
      return;
    }
    searchInput.hidden = false;
    const text = needle.trim().toLowerCase();
    const visible = text ? stations.filter((station) => station.search.includes(text)) : stations;
    if (!visible.length) {
      listHost.innerHTML = '<div class="empty"><b>No station matches</b><p class="small">Try another search or pick a different state.</p></div>';
      return;
    }
    listHost.innerHTML = visible.map((station) => `
      <label class="pickup-row${station.id === selected ? ' on' : ''}">
        <input type="radio" name="pickup-station" value="${esc(station.id)}" ${station.id === selected ? 'checked' : ''}>
        <span class="pickup-body">
          <b>${esc(stationShortName(station.name, 60))}</b>
          <small>${esc(station.address || '')}${station.landmark ? ` · near ${esc(station.landmark)}` : ''}</small>
          ${station.distance != null ? `<em>${esc(stationDistanceLabel(station))}</em>` : ''}
        </span>
      </label>`).join('');
  }

  async function showState(nextState, nextOrigin = null) {
    const seq = ++sequence;
    const opened = String(nextState || "");
    const changed = opened !== state;
    state = opened;
    origin = nextOrigin || null;
    // An in-progress search survives a re-read of the same state (a profile refresh);
    // only actually switching states clears it.
    if (changed) {
      needle = "";
      searchInput.value = "";
    }
    syncStateSelect();
    if (!state) {
      stations = [];
      setNote("");
      renderList();
      return;
    }
    listHost.innerHTML = '<div class="empty"><b>Loading stations…</b></div>';
    try {
      const rows = orderStations(await fetchPickupStations(state), origin);
      if (seq !== sequence) return; // a newer state (or refresh) is already loading
      stations = rows;
      failure = "";
      setNote(`${stations.length} station${stations.length === 1 ? '' : 's'} in ${state}${origin ? ' · closest first' : ''}`);
    } catch (problem) {
      if (seq !== sequence) return;
      stations = [];
      failure = problem?.message || 'Could not load the station list.';
      setNote("");
    }
    renderList();
  }

  function pick(id) {
    const station = stations.find((item) => item.id === id);
    if (!station) return;
    selected = id;
    followed = id; // chosen here — the customer already knows its state, never yank them
    syncRows();
    onSelect(station);
  }

  async function load({ keepSelection = false } = {}) {
    const seq = ++sequence;
    try {
      catalog = await fetchPickupCatalog();
      if (seq !== sequence) return;
      // A missing catalogue is the friendly empty state below, not an error.
      failure = "";
    } catch (problem) {
      if (seq !== sequence) return;
      catalog = null;
      failure = problem?.message || 'Could not load the station list.';
    }
    renderStates();
    if (!catalog) {
      stations = [];
      renderList();
      return;
    }
    // Follow a selection that is new to the picker (first load, or a station just saved
    // from elsewhere): open its state and keep it selected. Ordinary refreshes leave the
    // customer in the state they are browsing.
    let wanted = state;
    if (selected && selected !== followed && !stations.some((station) => station.id === selected)) {
      try {
        const all = await fetchAllPickupStations();
        if (seq !== sequence) return;
        const match = all.find((station) => station.id === selected);
        if (match) wanted = match.state;
        followed = selected; // handled — don't move the customer again on every refresh
      } catch { /* the picker still works without the saved row */ }
    }
    if (!selected) followed = "";
    if (wanted) await showState(wanted, keepSelection ? origin : null);
    else renderList();
    if (keepSelection) syncRows();
  }

  stateSelect.addEventListener('change', () => showState(stateSelect.value));
  searchInput.addEventListener('input', () => { needle = searchInput.value; renderList(); });
  listHost.addEventListener('change', (event) => {
    const input = event.target.closest('input[name="pickup-station"]');
    if (input) pick(input.value);
  });
  locateButton.addEventListener('click', () => {
    if (!navigator.geolocation) return setNote('This browser cannot share a location — pick your state instead.');
    locateButton.disabled = true;
    locateButton.textContent = 'Finding you…';
    setNote('Waiting for your location…');
    navigator.geolocation.getCurrentPosition(async (position) => {
      const seq = ++sequence;
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      try {
        const all = orderStations(await fetchAllPickupStations(), point);
        if (seq !== sequence) return; // the customer moved on while the list loaded
        const nearest = all.find((station) => station.distance != null) || all[0];
        if (!nearest) return setNote('No stations to compare with yet.');
        state = nearest.state;
        origin = point;
        stations = all.filter((station) => station.state === state);
        syncStateSelect();
        setNote(`${stations.length} station${stations.length === 1 ? '' : 's'} in ${state} · closest first`);
        renderList();
        pick(nearest.id);
      } catch (problem) {
        setNote(problem?.message || 'Could not load the station list.');
      } finally {
        locateButton.disabled = false;
        locateButton.textContent = 'Use my location';
      }
    }, () => {
      locateButton.disabled = false;
      locateButton.textContent = 'Use my location';
      setNote('Location was not shared — pick your state instead.');
    }, { timeout: 8000, maximumAge: 600000 });
  });

  load().catch((problem) => {
    failure = problem?.message || 'Could not load the station list.';
    renderList();
  });

  return {
    // Re-reads the catalogue (e.g. after the admin publishes). A newly saved station is
    // followed to its state; the customer's own browsing is left alone.
    refresh: (nextSelectedId = selected) => {
      selected = String(nextSelectedId || "");
      return load({ keepSelection: true });
    },
    // Scrolls the chooser into view — the cart's "choose a station" button uses this.
    focus: () => {
      host.scrollIntoView({ behavior: 'smooth', block: 'center' });
      stateSelect.focus();
    },
    getSelected: () => stations.find((station) => station.id === selected) || null
  };
}

// ---------- Checkout and admin actions (Firestore transactions, enforced by firestore.rules) ----------
export const MAX_CART_LINES = 5;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PICKUP_ID_PATTERN = /^[A-Za-z0-9_-]{2,40}$/;
// Checks the pickup station the order uses. The station's own document decides the
// name, state and address on the order; the security rules read the same document again,
// so an order can only carry a real station for the admin to review.
async function validatePickupStation(pickup) {
  const id = String(pickup?.stationId || "").trim();
  if (!PICKUP_ID_PATTERN.test(id)) {
    throw new Error("Choose the pickup station for this order.");
  }
  const snap = await getDoc(doc(db, "pickupStations", id));
  const station = snap.exists() ? snap.data() : null;
  if (!station || station.active !== true) {
    throw new Error("That pickup station is no longer available. Choose another one.");
  }
  return {
    method: "pickup",
    country: PICKUP_COUNTRY,
    state: String(station.state || "").slice(0, 40),
    stationId: id,
    stationName: String(station.name || "").slice(0, 120),
    stationAddress: String(station.address || "").slice(0, 300),
    landmark: String(station.landmark || "").slice(0, 120)
  };
}

// Places an order: debits the wallet for the amount known now (items + service fee),
// leaves shipping blank for the admin, decrements stock and writes the order in one
// transaction. Retrying with the same requestId returns the original order instead of
// charging twice. Shipping is collected separately after the admin sets the fee.
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
    const variant = String(item?.variant || "").slice(0, 40);
    if (!productId || !ID_PATTERN.test(productId)) throw new Error("Product is invalid.");
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("Quantity must be a positive whole number.");
    }
    // Lines merge only when product AND variation match, so two variations stay separate lines.
    const key = `${productId}|${variant}`;
    const found = merged.get(key) || { productId, variant, quantity: 0 };
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
  // The station saved on the profile is the one this order delivers to. Read it (and the
  // station document itself) before the transaction: transactions only read through tx.
  const savedProfile = await getDoc(userRef);
  if (!savedProfile.exists()) throw new Error("Your profile is not ready yet. Sign out and back in.");
  const delivery = await validatePickupStation(savedProfile.data().pickup);

  return runTransaction(db, async (tx) => {
    const existing = await tx.get(orderRef);
    if (existing.exists()) {
      const order = existing.data();
      return { orderId, status: order.status, total: order.total, duplicate: true };
    }

    const profileSnap = await tx.get(userRef);
    if (!profileSnap.exists()) throw new Error("Your profile is not ready yet. Sign out and back in.");
    const profile = profileSnap.data();

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
      const variations = Array.isArray(product.variations) ? product.variations : [];
      const variantIndex = variations.findIndex(v => String(v?.name || "") === entry.variant);
      const price = Number(variantIndex >= 0 ? variations[variantIndex].price : product.price);
      const stock = Number(product.stock || 0);
      if (!Number.isInteger(price) || price <= 0) throw new Error(`${product.name} has no valid price.`);
      if (stock < entry.quantity) {
        throw new Error(stock > 0 ? `Only ${stock} left of ${product.name}.` : `${product.name} is out of stock.`);
      }
      // Clothing variations must be one the admin listed; products without variations
      // sell at the base price and any leftover label in the cart is ignored.
      if (variations.length && variantIndex < 0) {
        throw new Error(entry.variant
          ? `The selected variation is not available for ${product.name}.`
          : `Pick a variation for ${product.name} before buying.`);
      }
      const lineVariant = variantIndex >= 0 ? entry.variant : "";
      const minimum = Math.max(1, Number(product.minOrderQuantity || 1));
      if (entry.quantity < minimum) throw new Error(`${product.name} has a minimum order of ${minimum}.`);
      const lineTotal = price * entry.quantity;
      subtotal += lineTotal;
      lines.push({
        productId: entry.productId, name: String(product.name || "Product"), price,
        quantity: entry.quantity, lineTotal, variant: lineVariant, variantIndex
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
      subtotal: feeParts.subtotal,
      serviceFee: feeParts.serviceFee,
      shippingFee: null,
      total,
      amountPaid: total,
      amountDue: 0,
      shippingStatus: "pending",
      status: "paid",
      delivery,
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
      subtotal: feeParts.subtotal,
      serviceFee: feeParts.serviceFee,
      shippingFee: null,
      total,
      amountPaid: total,
      amountDue: 0,
      shippingStatus: "pending",
      balance: newBalance,
      duplicate: false
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
        // Carts saved before variations existed stored size/colour — keep those lines
        // separate by turning them into a label instead of merging their quantities.
        variant: cleanVariant(i.variant) || [cleanVariant(i.size), cleanVariant(i.color)].filter(Boolean).join(" · ").slice(0, 40)
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
export function addToCart(productId, quantity = 1, variantName = "") {
  const amount = Number(quantity);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Quantity must be a positive whole number.");
  const items = getCart();
  const variant = cleanVariant(variantName);
  const found = items.find((i) => i.productId === productId && i.variant === variant);
  if (found) {
    const combinedQuantity = found.quantity + amount;
    if (!Number.isSafeInteger(combinedQuantity)) throw new Error("The combined quantity is too large.");
    found.quantity = combinedQuantity;
  } else items.push({ productId, quantity: amount, variant });
  setCart(items);
}

// ---------- Page shells ----------
let alertsStarted = false;
const NAV = [
  ["shop.html", "Shop"],
  ["boost.html", "Boost"],
  ["esim.html", "eSIM"],
  ["cart.html", "Cart"],
  ["dashboard.html", "Account"]
];

// KORASTORE's WhatsApp channel. The floating button and the footer link both use it.
export const WHATSAPP_CHANNEL_URL = "https://whatsapp.com/channel/0029Vb91iDh8KMqn1ZD69W2m";
const WHATSAPP_ICON = `<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>`;

// Floating WhatsApp button, shown on every storefront page.
export function mountWhatsAppChannel() {
  if (document.querySelector(".wa-float")) return;
  const link = document.createElement("a");
  link.className = "wa-float";
  link.href = WHATSAPP_CHANNEL_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.dataset.track = "whatsapp-channel";
  link.setAttribute("aria-label", "Join the KORASTORE WhatsApp channel");
  link.title = "Join our WhatsApp channel";
  link.innerHTML = `${WHATSAPP_ICON}<span class="wa-float-text">Join our channel</span>`;
  document.body.appendChild(link);
}

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
          ${NAV.map(([href, label]) => `<a href="${href}" data-track="nav-${href.replace(".html", "")}" class="${active === href ? "on" : ""}">${label}${href === "cart.html" ? ` <span class="cart-count" id="cart-count">0</span>` : ""}</a>`).join("")}
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
  startCustomerShippingAlerts();
  mountWhatsAppChannel();
  startOneSignal();
  countVisit();
}

export function mountFooter() {
  const host = document.querySelector("#site-footer");
  if (!host) return;
  host.innerHTML = `
    <footer class="footer">
      <div class="wrap footer-inner">
        <div><b>KORASTORE</b><p>Find it. Fund it. Own it.</p></div>
        <div class="footer-links"><a href="shop.html" data-track="footer-shop">Shop</a><a href="boost.html" data-track="footer-boost">Boost</a><a href="esim.html" data-track="footer-esim">eSIM</a><a href="wallet.html" data-track="footer-wallet">Fund wallet</a><a href="orders.html" data-track="footer-orders">Orders</a><a href="${WHATSAPP_CHANNEL_URL}" target="_blank" rel="noopener noreferrer" data-track="footer-whatsapp-channel">WhatsApp channel</a><a href="mailto:beniwealth70@gmail.com" data-track="footer-contact">Contact</a></div>
        <small>© ${new Date().getFullYear()} KORASTORE</small>
      </div>
    </footer>`;
}

const ACCOUNT_TABS = [
  ["dashboard.html", "Overview"],
  ["wallet.html", "Fund wallet"],
  ["orders.html", "Orders"],
  ["esim.html", "eSIMs"],
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
    let unsubscribe = null;
    let unsubscribeWhenReady = false;
    let settled = false;
    let authTimeout;

    const finish = (user) => {
      if (settled) return;
      settled = true;
      clearTimeout(authTimeout);
      if (unsubscribe) unsubscribe();
      else unsubscribeWhenReady = true;
      resolve(user);
    };

    const deny = (title, detail, canRetry = false) => {
      if (!gate) return;
      gate.hidden = false;
      gate.innerHTML = `<div class="gate-card"><span class="gate-mark">!</span><h2>${esc(title)}</h2><p>${esc(detail)}</p>${canRetry ? `<a class="btn" href="${esc(activePage)}">Try again</a>` : ""}<a class="btn" href="index.html">Back to store</a></div>`;
    };

    const failCheck = () => {
      if (settled) return;
      deny("Could not check admin access", "We couldn't verify your sign-in session. Check your connection and try again.", true);
      finish(null);
    };

    const handleUser = async (user) => {
      if (settled) return;
      if (!user) {
        finish(null);
        location.replace(`login.html?next=${encodeURIComponent(activePage)}`);
        return;
      }
      if (!ADMIN_EMAILS.includes((user.email || "").trim().toLowerCase())) {
        deny("Admins only", "This area is restricted to approved KORASTORE administrators.");
        finish(null);
        return;
      }

      // A stalled profile refresh must not leave the gate spinning forever. If it
      // times out or fails, use the cached profile; Firestore rules still enforce
      // the verified-admin check on every read and write.
      let reloadTimeout;
      try {
        await Promise.race([
          user.reload(),
          new Promise((_, reject) => {
            reloadTimeout = setTimeout(() => reject(new Error("Profile refresh timed out.")), 8000);
          })
        ]);
      } catch { /* fall back to cached profile */ }
      finally { clearTimeout(reloadTimeout); }

      if (settled) return;
      if (!user.emailVerified) {
        deny("Verify your email first", "Administrator accounts must have a verified email address. Check your inbox for the verification link, then sign in again.");
        finish(null);
        return;
      }
      if (gate) gate.hidden = true;
      if (content) content.hidden = false;
      document.querySelectorAll("[data-signout]").forEach((button) => {
        button.addEventListener("click", async () => { await signOut(auth); location.replace("index.html"); });
      });
      finish(user);
    };

    authTimeout = setTimeout(() => {
      deny("Could not check admin access", "The sign-in check is taking too long. Check your connection and try again.", true);
      finish(null);
    }, 12000);

    try {
      unsubscribe = onAuthStateChanged(auth, (user) => {
        handleUser(user).catch(failCheck);
      }, failCheck);
      if (unsubscribeWhenReady) unsubscribe();
    } catch {
      failCheck();
    }
  });
}

const ADMIN_LINKS = [
  ["admin.html", "Overview", "◎"],
  ["admin-analytics.html", "Analytics", "◔"],
  ["admin-products.html", "Products", "▣"],
  ["admin-boost.html", "Boosting", "↗"],
  ["admin-esim.html", "eSIM plans", "◉"],
  ["admin-pickup.html", "Pickup stations", "⌖"],
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
    <div class="admin-foot"><button type="button" class="admin-alerts" data-admin-alerts hidden>🔔 Turn on funding alerts</button><a href="index.html">View storefront ↗</a><button type="button" data-signout>Sign out</button></div>`;
  // Browsers only show the permission prompt after a click, so the admin turns alerts on here.
  const alertsButton = host.querySelector("[data-admin-alerts]");
  if (alertsButton) {
    const syncAlerts = () => {
      const state = notificationState();
      alertsButton.hidden = state !== "default";
    };
    alertsButton.addEventListener("click", async () => {
      await requestNotificationPermission();
      syncAlerts();
    });
    syncAlerts();
  }
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

// Returns the admin-set price for a chosen variation, or the base price.
export function productPrice(product, variantName = "") {
  const options = Array.isArray(product?.variations) ? product.variations : [];
  const match = options.find(v => String(v?.name || "") === String(variantName || ""));
  return Math.round(Number(match?.price ?? product?.price) || 0);
}

// Selling price, with the original price slashed through when a discount is set.
export function priceHTML(product, extraClass = "product-price") {
  const optionPrices = (Array.isArray(product?.variations) ? product.variations : []).map(v => Math.round(Number(v.price) || 0)).filter(v => v > 0);
  const price = optionPrices.length ? Math.min(...optionPrices) : Math.round(Number(product?.price) || 0);
  const high = optionPrices.length ? Math.max(...optionPrices) : price;
  const compare = Math.round(Number(product?.compareAtPrice) || 0);
  const discounted = compare > price;
  const off = discounted ? Math.round((1 - price / compare) * 100) : 0;
  return `<div class="${extraClass}"><span>${high > price ? `${naira(price)} – ${naira(high)}` : naira(price)}</span>${discounted
    ? ` <s class="price-was">${naira(compare)}</s> <span class="price-off">−${off}%</span>` : ""}</div>`;
}

export const hasVariations = (product) =>
  Boolean(Array.isArray(product?.variations) && product.variations.length);

// The chosen variation label, with a fallback for orders saved before variations existed.
export function variantLabel(item) {
  return String(item?.variant || [item?.size, item?.color].filter(Boolean).join(" · ") || "");
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
          ${hasVariations(product)
    ? `<a class="btn btn-sm btn-gold" href="${link}">Choose variation</a>`
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
          tag: `recommended-${item.productId || item.id}`,
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

const MAX_SHIPPING_FEE = 5000000;

// The admin decides shipping after the customer has placed the order. This updates the
// order's final total and creates a private notification in the customer's account. The
// shipping amount is not debited here: the customer pays the newly disclosed amount from
// their wallet after receiving the notification.
export async function setOrderShippingFee(orderId, shippingFee) {
  const fee = Math.round(Number(shippingFee));
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > MAX_SHIPPING_FEE) {
    throw new Error("Shipping fee must be a whole amount between ₦0 and ₦5,000,000.");
  }
  const admin = auth.currentUser?.email || "admin";
  const orderRef = doc(db, "orders", orderId);

  return runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Order not found.");
    const order = orderSnap.data();
    if (order.status === "cancelled") throw new Error("A cancelled order cannot receive a shipping fee.");
    if (!("shippingStatus" in order)) {
      throw new Error("This order predates per-order shipping fees and cannot be changed here.");
    }
    const subtotal = Number(order.subtotal || 0);
    const serviceFee = Number(order.serviceFee || 0);
    const baseTotal = subtotal + serviceFee;
    if (order.shippingStatus === "paid" && Number(order.amountPaid || 0) > baseTotal) {
      throw new Error("Shipping has already been paid for this order.");
    }

    const amountPaid = Number(order.amountPaid ?? baseTotal);
    if (!Number.isSafeInteger(amountPaid) || amountPaid !== baseTotal) {
      throw new Error("This order has an invalid amount paid.");
    }
    const total = baseTotal + fee;
    const amountDue = total - amountPaid;
    const shippingStatus = amountDue > 0 ? "due" : "paid";

    tx.update(orderRef, {
      shippingFee: fee,
      total,
      amountDue,
      shippingStatus,
      shippingFeeSetAt: serverTimestamp(),
      shippingFeeSetBy: admin,
      updatedAt: serverTimestamp()
    });
    tx.set(doc(db, "users", order.uid, "notifications", `shipping_${orderId}`), {
      type: "shipping_fee",
      orderId,
      subtotal,
      serviceFee,
      shippingFee: fee,
      total,
      amountDue,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return { orderId, shippingFee: fee, total, amountDue, shippingStatus };
  });
}

// The customer pays the shipping amount after the admin has disclosed it. The wallet,
// order and wallet history are changed in the same transaction, so the amount cannot be
// charged twice by a retry.
export async function payShippingFee(orderId) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to pay the shipping fee.");
  const orderRef = doc(db, "orders", orderId);
  const userRef = doc(db, "users", user.uid);

  return runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Order not found.");
    const order = orderSnap.data();
    if (order.uid !== user.uid) throw new Error("You cannot pay another customer's order.");
    const amountDue = Number(order.amountDue || 0);
    const shippingFee = Number(order.shippingFee);
    if (order.status === "cancelled") throw new Error("A cancelled order has no shipping payment due.");
    if (order.shippingStatus !== "due" || !Number.isSafeInteger(amountDue) || amountDue <= 0
        || !Number.isSafeInteger(shippingFee) || shippingFee < 0) {
      throw new Error("There is no shipping payment due for this order.");
    }

    const profileSnap = await tx.get(userRef);
    if (!profileSnap.exists()) throw new Error("Your profile is not ready yet. Sign out and back in.");
    const profile = profileSnap.data();
    const balance = Number(profile.balance || 0);
    if (balance < amountDue) {
      throw new Error(`Your wallet has ${naira(balance)} but shipping costs ${naira(amountDue)}. Fund your wallet first.`);
    }
    const newBalance = balance - amountDue;
    const amountPaid = Number(order.amountPaid || 0) + amountDue;

    tx.update(userRef, { balance: newBalance, lastShippingOrderId: orderId, updatedAt: serverTimestamp() });
    tx.update(orderRef, {
      amountPaid,
      amountDue: 0,
      shippingStatus: "paid",
      shippingPaidAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    tx.set(doc(db, "users", user.uid, "transactions", `shipping_${orderId}`), {
      type: "shipping", title: `Shipping · Order ${orderId.slice(-6).toUpperCase()}`,
      amount: -amountDue, status: "paid", orderId, balanceAfter: newBalance, createdAt: serverTimestamp()
    });
    tx.set(doc(db, "ledger", `shipping_${orderId}`), {
      type: "shipping", uid: user.uid, amount: -amountDue, balanceAfter: newBalance,
      reference: orderId, actor: user.uid, createdAt: serverTimestamp()
    });
    return { orderId, shippingFee, amountPaid, balance: newBalance };
  });
}

// Moves an order forward. Cancelling refunds only what the customer has actually paid
// (including shipping when it was paid) and restocks every line.
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
    if (status !== "cancelled" && Number(order.amountDue || 0) > 0) {
      throw new Error("Set and collect the shipping fee before fulfilment can begin.");
    }

    if (status !== "cancelled") {
      tx.update(orderRef, { status, updatedAt: serverTimestamp() });
      return { orderId, status };
    }

    const refund = Number(order.amountPaid ?? order.total ?? 0);
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
    const cancellation = { status: "cancelled", cancelledAt: serverTimestamp(), updatedAt: serverTimestamp() };
    if ("shippingStatus" in order || "amountPaid" in order) {
      cancellation.amountDue = 0;
      cancellation.shippingStatus = "cancelled";
    }
    tx.update(orderRef, cancellation);
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

// ---------- Social media boosting ----------
// The admin runs a boosting catalogue: platforms (Facebook, TikTok, YouTube, …),
// categories inside them (Followers, Likes, Views, …), and plans — each GSUBZ price
// is a rate per 1,000 units, with the source plan's min/max quantity and average
// delivery time. Shoppers order a quantity and pay the proportional rate from their
// wallet; there is no delivery and no checkout fee on boost orders.
export const BOOST_ID_PATTERN = /^[A-Za-z0-9_-]{2,40}$/;
// Hard ceiling for any boost quantity. A plan can narrow it with minQuantity /
// maxQuantity (maxQuantity 0 or missing means "no maximum"). GSUBZ's unlimited
// marker is 2,147,483,647, so the site cap keeps the money maths safe.
export const BOOST_MAX_QUANTITY = 10000000;
// Rate bounds for the imported/admin-editable catalogue, in naira per 1,000 units.
export const BOOST_MIN_RATE_PER_THOUSAND = 500;
export const BOOST_MAX_RATE_PER_THOUSAND = 50000;
// KORASTORE rate = GSUBZ rate × this markup.
export const BOOST_SITE_MARKUP = 2;
// No average time promised on the site is shorter than an hour, whatever the
// source catalogue claims.
export const BOOST_MIN_AVERAGE_TIME_MINUTES = 60;

// Effective order limits for a plan. These stay aligned with GSUBZ's source
// minimum and maximum (maxQuantity 0 or missing means no maximum).
export function boostServiceLimits(service = {}) {
  const minRaw = Number(service.minQuantity);
  const min = Number.isInteger(minRaw) && minRaw >= 1
    ? Math.min(minRaw, BOOST_MAX_QUANTITY)
    : 1;
  const maxRaw = Number(service.maxQuantity);
  const max = Number.isInteger(maxRaw) && maxRaw >= min
    ? Math.min(maxRaw, BOOST_MAX_QUANTITY)
    : BOOST_MAX_QUANTITY;
  return { min, max };
}

// "Min: 100 | Max: 2,000,000" (the max is hidden when the plan sets none).
export function formatBoostLimits(service = {}) {
  const { min, max } = boostServiceLimits(service);
  const low = `Min: ${min.toLocaleString('en-NG')}`;
  return max >= BOOST_MAX_QUANTITY ? low : `${low} | Max: ${max.toLocaleString('en-NG')}`;
}

// A plan's rate per 1,000 units, as whole kobo (₦1 = 100). Working in kobo
// keeps fractional rates exact. Returns 0 when the price is unusable.
export function boostPriceKobo(price) {
  const amount = Number(price);
  if (!Number.isFinite(amount)) return 0;
  const kobo = Math.round(amount * 100);
  return Number.isSafeInteger(kobo) && kobo >= 1 ? kobo : 0;
}

// Reads an admin-typed rate per 1,000 units, or null when it is outside the
// catalogue's ₦500–₦50,000 range or has more than two decimal places.
export function parseBoostPrice(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return null;
  const kobo = boostPriceKobo(text);
  if (!kobo || kobo < boostPriceKobo(BOOST_MIN_RATE_PER_THOUSAND)
      || kobo > boostPriceKobo(BOOST_MAX_RATE_PER_THOUSAND)) return null;
  return kobo / 100;
}

// What a boost order costs: rate per 1,000 × quantity / 1,000, calculated in
// kobo and rounded to the nearest whole naira because the wallet holds no kobo.
// Never charge less than ₦1. Returns 0 when the price or quantity is unusable.
export function boostOrderTotal(pricePerThousand, quantity) {
  const rateKobo = boostPriceKobo(pricePerThousand);
  const units = Number(quantity);
  if (!rateKobo
      || rateKobo < boostPriceKobo(BOOST_MIN_RATE_PER_THOUSAND)
      || rateKobo > boostPriceKobo(BOOST_MAX_RATE_PER_THOUSAND)) return 0;
  if (!Number.isSafeInteger(units) || units < 1 || units > BOOST_MAX_QUANTITY) return 0;
  const koboTimesUnits = rateKobo * units;
  if (!Number.isSafeInteger(koboTimesUnits)) return 0; // too large to price exactly
  const total = Math.round(koboTimesUnits / 100000); // kobo / 1,000 / 100 kobo per naira
  return total < 1 ? 1 : total;
}

// Whole-naira rates display without decimals; fractional rates show two decimals.
export function formatBoostPrice(price) {
  const kobo = boostPriceKobo(price);
  if (!kobo) return naira(0);
  const whole = Math.floor(kobo / 100);
  const rest = kobo % 100;
  return rest ? `₦${whole.toLocaleString('en-NG')}.${String(rest).padStart(2, '0')}` : naira(whole);
}

// ---------- GSUBZ catalogue import (Admin → Boosting) ----------
// The boosting catalogue is a snapshot of GSUBZ's "Socials Media Market"
// (data/gsubz-socials-services.json). It keeps the cheapest qualifying plan(s) in
// each category whose KORASTORE rate is ₦500–₦50,000 per 1,000 units (the site rate
// remains 2× GSUBZ). The admin edits just that rate and average time; names, units
// and source quantity limits are synced from GSUBZ.

// Parses "3 hours 42 minutes", "45 minutes", "1h 30m" … into total minutes, or
// null when the text does not describe a duration.
export function boostAverageMinutes(text) {
  const t = String(text || "").toLowerCase();
  const hours = t.match(/(\d+)\s*h(?:ou)?r?s?/);
  const minutes = t.match(/(\d+)\s*m(?:in)?(?:ute)?s?/);
  if (!hours && !minutes) return null;
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return Number.isFinite(total) ? total : null;
}

// Minutes → "1 hour", "2 hours 20 minutes", "45 minutes".
export function formatBoostAverageMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours && rest) return `${hours} hour${hours === 1 ? "" : "s"} ${rest} minute${rest === 1 ? "" : "s"}`;
  if (hours) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${rest} minute${rest === 1 ? "" : "s"}`;
}

// The site never promises faster than an hour: source times below the floor (or
// missing entirely) are published as "1 hour".
export function normalizeBoostAverageTime(text) {
  const minutes = boostAverageMinutes(String(text || "").replace(/^average time:\s*/i, ""));
  return formatBoostAverageMinutes(Math.max(minutes ?? 0, BOOST_MIN_AVERAGE_TIME_MINUTES));
}

// Admin-edited average times keep the admin's own wording — but when the text
// parses as a duration it must not promise less than the site minimum (1 hour).
// Returns an error message, or null when the value is fine.
export function validateBoostAverageTime(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return "Enter an average time, e.g. “1 hour”.";
  if (raw.length > 120) return "Average time must be 120 characters or fewer.";
  const minutes = boostAverageMinutes(raw);
  if (minutes != null && minutes < BOOST_MIN_AVERAGE_TIME_MINUTES) {
    return "The minimum average time on KORASTORE is 1 hour.";
  }
  return null;
}

// "Instagram Video Views …" → "views": the service noun in the plan/category name.
export function boostUnitFromName(name) {
  const text = String(name || "");
  const rules = [
    [/\bviews?\b/i, "views"],
    [/\bfollowers?\b/i, "followers"],
    [/\blikes?\b/i, "likes"],
    [/\bsubscribers?\b/i, "subscribers"],
    [/\bmembers?\b/i, "members"],
    [/\bplays?\b/i, "plays"],
    [/\bcomments?\b/i, "comments"],
    [/\bshares?\b/i, "shares"],
    [/\bretweets?\b/i, "retweets"],
    [/\breactions?\b/i, "reactions"],
    [/\bclicks?\b/i, "clicks"],
    [/\bvotes?\b/i, "votes"],
    [/\bsaves?\b/i, "saves"],
    [/\bimpressions?\b/i, "impressions"],
    [/\bstreams?\b/i, "streams"],
    [/\blisteners?\b/i, "listeners"],
    [/\bbookmarks?\b/i, "bookmarks"],
    [/\bmentions?\b/i, "mentions"],
    [/\bvisitors?\b/i, "visitors"],
    [/\bvisits?\b/i, "visits"],
    [/\btraffic\b/i, "visits"],
    [/\bfans?\b/i, "fans"],
    [/\bfriends?\b/i, "friends"],
    [/\bjoins?\b/i, "joins"],
    [/\bstarts?\b/i, "starts"],
    // Watch-time products are priced in hours — but only when no concrete noun
    // above already named the unit ("Facebook Watch Time Views" is a views plan,
    // while "YouTube Watch Hours" sells hours).
    [/\bwatch\s*(?:time|hours?)\b/i, "hours"]
  ];
  for (const [pattern, unit] of rules) if (pattern.test(text)) return unit;
  return "unit";
}

// The platform family behind a GSUBZ category name ("Twitter Brazil 🇧🇷 Services"
// → Twitter). Platforms are plumbing only — category names are self-describing.
const BOOST_PLATFORM_FAMILIES = [
  ["Instagram", /instagram/i],
  ["Facebook", /facebook/i],
  ["Twitter", /twitter/i],
  ["Telegram", /telegram/i],
  ["TikTok", /tiktok/i],
  ["YouTube", /youtube/i],
  ["Spotify", /spotify/i],
  ["WhatsApp", /whats\s?app/i],
  ["Twitch", /twitch/i],
  ["Kick", /\bkick\b/i],
  ["LinkedIn", /linkedin/i],
  ["Threads", /\bthreads\b/i],
  ["Discord", /discord/i],
  ["Reddit", /reddit/i],
  ["Pinterest", /pinterest/i],
  ["Snapchat", /snapchat/i],
  ["Bluesky", /bluesky/i],
  ["Quora", /quora/i],
  ["Medium", /\bmedium\b/i],
  ["Audiomack", /audiomack/i],
  ["Boomplay", /boomplay/i],
  ["Apple Music", /apple\s?music/i],
  ["Deezer", /deezer/i],
  ["Mixcloud", /mixcloud/i],
  ["Genius", /\bgenius\b/i],
  ["Website & SEO", /web\s?site|\bseo\b|google|traffic|backlink|linktree|ranking/i],
  ["E-Commerce", /e-?commerce|amazon|ebay|shopee|play\s?store|app\s?store/i]
];

export function boostPlatformFromName(name) {
  const text = String(name || "");
  for (const [family, pattern] of BOOST_PLATFORM_FAMILIES) {
    if (pattern.test(text)) return family;
  }
  return "Other";
}

// Truncates to a byte budget (the Firestore rules measure strings in bytes, and
// GSUBZ names carry emoji that take up to 4 bytes each). Never returns "".
function truncateUtf8(text, maxBytes, fallback = "—") {
  const source = String(text || "");
  let out = "";
  let bytes = 0;
  for (const ch of source) {
    const size = new TextEncoder().encode(ch).length;
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  out = out.trim();
  return out || fallback;
}

const boostSlug = (text, max) => String(text || "").toLowerCase()
  .normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);

// Small deterministic hash (djb2 → 6 base36 chars) so category ids are stable
// across re-publishes and cannot collide after name truncation.
function boostHash(text) {
  let hash = 5381;
  for (const ch of String(text)) hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
  return hash.toString(36).padStart(6, "0").slice(0, 6);
}

// GSUBZ marks "no maximum" as 2,147,483,647; the site stores 0 = no maximum.
function boostSourceMax(value) {
  const max = Math.floor(Number(value) || 0);
  if (max < 1 || max >= 2147483647) return 0;
  return Math.min(max, BOOST_MAX_QUANTITY);
}

// Turns the GSUBZ snapshot into the three collections the store sells from.
// Pure: ids are deterministic (a re-publish upserts the same documents), and for
// each category it keeps the cheapest plan(s) whose KORASTORE rate (2× the GSUBZ
// per-1,000 rate) falls within ₦500–₦50,000. Ties all come across. Free-service
// categories are not sold here; source min/max quantities remain unchanged.
export function buildBoostCatalogFromGsubz(raw) {
  const services = Array.isArray(raw?.services) ? raw.services : [];
  const byCategory = new Map();
  for (const service of services) {
    const categoryName = String(service?.category || "").trim();
    // Free-service categories are not sold here — anything with "free" in the
    // category name stays out of the catalogue.
    if (!categoryName || /free/i.test(categoryName)) continue;
    if (!byCategory.has(categoryName)) byCategory.set(categoryName, []);
    byCategory.get(categoryName).push(service);
  }
  const platforms = new Map();
  const categories = [];
  const plans = [];
  for (const [categoryName, rows] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const eligible = rows.map((row) => ({
      row,
      sourcePrice: Number(row.price) || 0,
      price: Math.round((Number(row.price) || 0) * BOOST_SITE_MARKUP * 100) / 100
    })).filter(({ sourcePrice, price }) =>
      boostPriceKobo(sourcePrice) > 0
      && price >= BOOST_MIN_RATE_PER_THOUSAND
      && price <= BOOST_MAX_RATE_PER_THOUSAND);
    if (!eligible.length) continue;
    const lowestPrice = Math.min(...eligible.map(({ price }) => price));
    const winners = eligible
      .filter(({ price }) => price === lowestPrice)
      .map(({ row }) => row)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const family = boostPlatformFromName(categoryName);
    const platformId = boostSlug(family, 40) || "other";
    if (!platforms.has(platformId)) {
      platforms.set(platformId, { id: platformId, name: family, description: "", active: true });
    }
    const categoryId = `gcat-${boostSlug(categoryName, 26)}-${boostHash(categoryName)}`;
    categories.push({
      id: categoryId,
      platformId,
      name: truncateUtf8(categoryName, 80, "Category"),
      description: "",
      active: true
    });
    for (const row of winners) {
      const sourcePrice = Number(row.price) || 0;
      const detail = String(row.description || "").split("\n")
        .filter((line) => line.trim() && !/^average time:/i.test(line.trim()))
        .join(" ").trim();
      const averageTime = normalizeBoostAverageTime(row.description);
      const price = Math.round(sourcePrice * BOOST_SITE_MARKUP * 100) / 100;
      plans.push({
        id: `gsvc-${row.id}`,
        categoryId,
        name: truncateUtf8(String(row.name || "Service"), 120, "Service"),
        description: truncateUtf8(detail, 500, ""),
        unit: boostUnitFromName(`${row.name || ""} ${categoryName}`),
        price,
        priceBasis: 1000,
        // The defaults are remembered so a re-publish only overwrites a rate or
        // average time the admin has NOT edited.
        defaultPrice: price,
        minQuantity: Math.max(1, Math.floor(Number(row.min) || 1)),
        maxQuantity: boostSourceMax(row.max),
        averageTime,
        defaultAverageTime: averageTime,
        active: true
      });
    }
  }
  return { platforms: [...platforms.values()], categories, plans };
}
const BOOST_COLLECTIONS = {
  platform: "boostPlatforms",
  category: "boostCategories",
  subcategory: "boostSubcategories"
};

export function watchBoostPlatforms(callback, onError = noop, { includeInactive = false } = {}) {
  const ref = includeInactive ? collection(db, "boostPlatforms") : query(collection(db, "boostPlatforms"), where("active", "==", true));
  return onSnapshot(ref, (snap) => callback(rows(snap)), onError);
}

export function watchBoostCategories(callback, onError = noop, { includeInactive = false } = {}) {
  const ref = includeInactive ? collection(db, "boostCategories") : query(collection(db, "boostCategories"), where("active", "==", true));
  return onSnapshot(ref, (snap) => callback(rows(snap)), onError);
}

export function watchBoostSubcategories(callback, onError = noop, { includeInactive = false } = {}) {
  const ref = includeInactive ? collection(db, "boostSubcategories") : query(collection(db, "boostSubcategories"), where("active", "==", true));
  return onSnapshot(ref, (snap) => callback(rows(snap)), onError);
}

// kind is "platform", "category" or "subcategory". The admin-chosen id is the
// Firestore document id.
export function saveBoostItem(kind, id, data, { isNew = false } = {}) {
  const collectionName = BOOST_COLLECTIONS[kind];
  if (!collectionName) throw new Error("Unknown boosting item.");
  if (typeof id !== "string" || !BOOST_ID_PATTERN.test(id)) {
    throw new Error("ID must be 2–40 letters, numbers, dashes or underscores.");
  }
  const payload = { ...data, updatedAt: serverTimestamp() };
  if (isNew) return setDoc(doc(db, collectionName, id), { ...payload, createdAt: serverTimestamp() });
  return updateDoc(doc(db, collectionName, id), payload);
}

// Publishes an imported GSUBZ catalogue (buildBoostCatalogFromGsubz output):
// upserts platforms, categories and plans in batches, then hides anything else
// that is still live (the old manual catalogue). Price and averageTime belong to
// the store, not to GSUBZ — re-publishing keeps the admin's edits. A price edit is
// carried over only when its priceBasis matches, so old per-unit rates are not
// mistakenly reused as per-1,000 rates during this migration.
export async function publishBoostCatalog({ platforms = [], categories = [], plans = [], existing = {}, hideOthers = true } = {}) {
  const before = new Map((existing.plans || []).map((row) => [row.id, row]));
  const upserts = [
    ...platforms.map((row) => ({ id: row.id, collection: "boostPlatforms", data: row })),
    ...categories.map((row) => ({ id: row.id, collection: "boostCategories", data: row })),
    ...plans.map((plan) => {
      const data = { ...plan };
      const old = before.get(plan.id);
      if (old) {
        if (old.priceBasis === plan.priceBasis && old.price != null && old.price !== old.defaultPrice) {
          data.price = old.price;
        }
        if (old.averageTime && old.averageTime !== old.defaultAverageTime) data.averageTime = old.averageTime;
      }
      return { id: plan.id, collection: "boostSubcategories", data };
    })
  ];
  const keep = {
    boostPlatforms: new Set(platforms.map((row) => row.id)),
    boostCategories: new Set(categories.map((row) => row.id)),
    boostSubcategories: new Set(plans.map((row) => row.id))
  };
  const collectionFor = { platforms: "boostPlatforms", categories: "boostCategories", plans: "boostSubcategories" };
  const hides = [];
  if (hideOthers) {
    for (const [key, rows] of Object.entries({ platforms: [], categories: [], plans: [], ...existing })) {
      const collection = collectionFor[key];
      if (!collection) continue;
      for (const row of rows) if (!keep[collection].has(row.id)) hides.push({ id: row.id, collection, data: { active: false } });
    }
  }
  const writes = [...upserts, ...hides];
  for (let start = 0; start < writes.length; start += 400) {
    const batch = writeBatch(db);
    for (const write of writes.slice(start, start + 400)) {
      batch.set(doc(db, write.collection, write.id), { ...write.data, updatedAt: serverTimestamp() }, { merge: true });
    }
    await batch.commit();
  }
  return { written: upserts.length, hidden: hides.length };
}

// Buys one boosting service: the catalogue's rate per 1,000 × quantity / 1,000,
// paid from the wallet. The order id is "<uid>_<requestId>", so a retried checkout
// returns the original order instead of charging twice.
export async function placeBoostOrder(requestId, { subcategoryId, quantity, link }) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to continue.");
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 80 || !ID_PATTERN.test(requestId)) {
    throw new Error("Request ID is invalid.");
  }
  const amount = Number(quantity);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > BOOST_MAX_QUANTITY) {
    throw new Error(`Quantity must be a positive whole number (up to ${BOOST_MAX_QUANTITY.toLocaleString('en-NG')} units).`);
  }
  const target = String(link || "").trim().slice(0, 300);
  if (!target) throw new Error("Enter the link or username to boost.");
  if (typeof subcategoryId !== "string" || !BOOST_ID_PATTERN.test(subcategoryId)) {
    throw new Error("Service is invalid.");
  }

  const uid = user.uid;
  const orderId = `${uid}_${requestId}`;
  const orderRef = doc(db, "boostOrders", orderId);
  const userRef = doc(db, "users", uid);

  return runTransaction(db, async (tx) => {
    const existing = await tx.get(orderRef);
    if (existing.exists()) {
      const order = existing.data();
      return { orderId, status: order.status, total: order.total, duplicate: true };
    }

    const serviceSnap = await tx.get(doc(db, "boostSubcategories", subcategoryId));
    const service = serviceSnap.exists() ? serviceSnap.data() : null;
    if (!service || service.active !== true) throw new Error("This service is not available right now.");
    const categorySnap = await tx.get(doc(db, "boostCategories", String(service.categoryId || "")));
    const category = categorySnap.exists() ? categorySnap.data() : null;
    if (!category || category.active !== true) throw new Error("This service is not available right now.");
    const platformSnap = await tx.get(doc(db, "boostPlatforms", String(category.platformId || "")));
    const platform = platformSnap.exists() ? platformSnap.data() : null;
    if (!platform || platform.active !== true) throw new Error("This service is not available right now.");

    if (Number(service.priceBasis) !== 1000) {
      throw new Error("The boost catalogue needs republishing before this plan can be ordered.");
    }
    const ratePerThousand = Number(service.price);
    if (!boostPriceKobo(ratePerThousand)
        || ratePerThousand < BOOST_MIN_RATE_PER_THOUSAND
        || ratePerThousand > BOOST_MAX_RATE_PER_THOUSAND) {
      throw new Error("This service's per-1,000 rate is outside the allowed ₦500–₦50,000 range.");
    }
    // The plan's own limits, read inside the transaction so they cannot be stale.
    const { min, max } = boostServiceLimits(service);
    if (amount < min) throw new Error(`This plan needs a quantity of at least ${min.toLocaleString('en-NG')}.`);
    if (amount > max) throw new Error(`This plan allows a quantity of at most ${max.toLocaleString('en-NG')}.`);
    // Rate per 1,000 × quantity / 1,000, rounded to whole naira (the wallet holds no kobo).
    const total = boostOrderTotal(ratePerThousand, amount);
    if (!total) throw new Error("That quantity is too large.");

    const profileSnap = await tx.get(userRef);
    if (!profileSnap.exists()) throw new Error("Your profile is not ready yet. Sign out and back in.");
    const balance = Number(profileSnap.data().balance || 0);
    if (balance < total) {
      throw new Error(`Your wallet has ${naira(balance)} but this order costs ${naira(total)}. Fund your wallet first.`);
    }
    const newBalance = balance - total;

    tx.update(userRef, { balance: newBalance, lastBoostOrderId: orderId, updatedAt: serverTimestamp() });
    tx.set(orderRef, {
      uid, requestId,
      platformId: platformSnap.id, platformName: String(platform.name || "Platform").slice(0, 80),
      categoryId: categorySnap.id, categoryName: String(category.name || "Category").slice(0, 80),
      subcategoryId: serviceSnap.id, subcategoryName: String(service.name || "Service").slice(0, 120),
      unit: String(service.unit || "").slice(0, 60),
      unitPrice: ratePerThousand, priceBasis: 1000, quantity: amount, total,
      link: target, status: "paid",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    tx.set(doc(db, "users", uid, "transactions", `boost_${orderId}`), {
      type: "boost", title: `Boost · ${String(service.name || "Service").slice(0, 60)}`, amount: -total,
      status: "paid", orderId, balanceAfter: newBalance, createdAt: serverTimestamp()
    });
    tx.set(doc(db, "ledger", `boost_${orderId}`), {
      type: "boost", uid, amount: -total, balanceAfter: newBalance,
      reference: orderId, actor: uid, createdAt: serverTimestamp()
    });
    return {
      orderId, status: "paid", unitPrice: ratePerThousand, priceBasis: 1000, quantity: amount,
      total, balance: newBalance, duplicate: false
    };
  });
}

const BOOST_ORDER_TRANSITIONS = {
  paid: ["processing", "cancelled"],
  processing: ["delivered", "cancelled"],
  delivered: [],
  cancelled: []
};
export const NEXT_BOOST_ACTIONS = {
  paid: [["processing", "Start work"], ["cancelled", "Cancel & refund"]],
  processing: [["delivered", "Mark delivered"], ["cancelled", "Cancel & refund"]],
  delivered: [],
  cancelled: []
};

// Admin moves a boost order forward, or cancels it (refunding the wallet in the
// same transaction). Digital service: paid → processing → delivered.
export async function setBoostOrderStatus(orderId, status) {
  if (!["processing", "delivered", "cancelled"].includes(status)) {
    throw new Error("Status must be processing, delivered or cancelled.");
  }
  const admin = auth.currentUser?.email || "admin";
  const orderRef = doc(db, "boostOrders", orderId);

  return runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Boost order not found.");
    const order = orderSnap.data();
    if (!BOOST_ORDER_TRANSITIONS[order.status]?.includes(status)) {
      throw new Error(`A boost order that is ${order.status} cannot be changed to ${status}.`);
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

    tx.update(userRef, { balance: newBalance, updatedAt: serverTimestamp() });
    tx.update(orderRef, { status: "cancelled", cancelledAt: serverTimestamp(), updatedAt: serverTimestamp() });
    tx.set(doc(db, "users", order.uid, "transactions", `boostrefund_${orderId}`), {
      type: "refund", title: `Refund · Boost ${orderId.slice(-6).toUpperCase()}`, amount: refund,
      status: "refunded", orderId, balanceAfter: newBalance, createdAt: serverTimestamp()
    });
    tx.set(doc(db, "ledger", `boostrefund_${orderId}`), {
      type: "refund", uid: order.uid, amount: refund, balanceAfter: newBalance,
      reference: orderId, actor: admin, createdAt: serverTimestamp()
    });
    return { orderId, status: "cancelled", refunded: refund, balance: newBalance };
  });
}

export function watchMyBoostOrders(uid, callback, onError = noop) {
  return onSnapshot(query(collection(db, "boostOrders"), where("uid", "==", uid)), (snap) => {
    callback(rows(snap).sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)));
  }, onError);
}

export function watchAllBoostOrders(callback, onError = noop) {
  return onSnapshot(collection(db, "boostOrders"), (snap) => {
    callback(rows(snap).sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)));
  }, onError);
}

// ---------- Travel eSIMs ----------
// Admins type each plan in by hand under Admin → eSIM plans: destination, allowance,
// validity, price and activation notes. Customers buy a plan on esim.html and pay from
// their wallet, exactly like a boost order — one digital item, no shipping, no service
// fee. Plans, validation and limits come from esim-catalogue.mjs, which firestore.rules
// mirrors, so the browser and the rules cannot disagree about a price.
export function watchEsimPlans(callback, onError = noop, { includeInactive = false } = {}) {
  const ref = includeInactive ? collection(db, "esimPlans") : query(collection(db, "esimPlans"), where("active", "==", true));
  return onSnapshot(ref, (snap) => callback(rows(snap)), onError);
}

// The admin-chosen plan id is the Firestore document id, so a plan keeps a stable id.
export function saveEsimPlan(planId, data, { isNew = false } = {}) {
  const { ok, error, plan } = validatePlanDraft({ ...data, planId }, { editingId: isNew ? null : planId });
  if (!ok) throw new Error(error);
  const payload = { ...plan, updatedAt: serverTimestamp() };
  if (isNew) return setDoc(doc(db, "esimPlans", planId), { ...payload, sold: 0, createdAt: serverTimestamp() });
  return updateDoc(doc(db, "esimPlans", planId), payload);
}

// Buys one plan (or a few for a group) from the wallet. The order id is
// "<uid>_<requestId>", so a retried checkout returns the original order instead of
// charging twice. The plan is re-read inside the transaction, so its live price and
// details are what the customer pays and what the order records.
export async function placeEsimOrder(requestId, { planId, quantity = 1 } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in to continue.");
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 80 || !ID_PATTERN.test(requestId)) {
    throw new Error("Request ID is invalid.");
  }
  const amount = Math.round(Number(quantity));
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > ESIM_MAX_QUANTITY) {
    throw new Error(`Choose between 1 and ${ESIM_MAX_QUANTITY} eSIMs per order.`);
  }
  if (typeof planId !== "string" || !ESIM_PLAN_ID_PATTERN.test(planId)) throw new Error("Choose a plan to continue.");

  const uid = user.uid;
  const orderId = `${uid}_${requestId}`;
  const orderRef = doc(db, "esimOrders", orderId);
  const userRef = doc(db, "users", uid);
  const planRef = doc(db, "esimPlans", planId);

  return runTransaction(db, async (tx) => {
    const existing = await tx.get(orderRef);
    if (existing.exists()) {
      const order = existing.data();
      return { orderId, status: order.status, total: order.total, duplicate: true };
    }

    const planSnap = await tx.get(planRef);
    const plan = planSnap.exists() ? planSnap.data() : null;
    if (!plan || plan.active !== true) throw new Error("This plan is not available right now.");
    // Re-validate the stored plan with the same validator the admin form uses, so the
    // order can never carry details the security rules would refuse (which a shopper
    // would otherwise see as "insufficient permissions").
    const { ok, plan: stored } = validatePlanDraft({ ...plan, planId: planSnap.id }, { editingId: planSnap.id });
    // The rules compare the order against the plan document field by field, so the
    // normalised copy must be exactly what is stored; anything else would be refused
    // server-side and shown to the shopper as a permission error.
    const usable = ok
      && stored.price === Number(plan.price)
      && stored.validityDays === Number(plan.validityDays)
      && stored.destinationId === String(plan.destinationId)
      && stored.destinationName === String(plan.destinationName)
      && stored.data === String(plan.data);
    if (!usable) throw new Error("This plan's details are incomplete. Tell us and we will fix it.");
    const unitPrice = stored.price;
    const total = esimOrderTotal(unitPrice, amount);
    if (!total) throw new Error("This plan's price is outside the allowed range.");

    const profileSnap = await tx.get(userRef);
    if (!profileSnap.exists()) throw new Error("Your profile is not ready yet. Sign out and back in.");
    const balance = Number(profileSnap.data().balance || 0);
    if (balance < total) {
      throw new Error(`Your wallet has ${naira(balance)} but this order costs ${naira(total)}. Fund your wallet first.`);
    }
    const newBalance = balance - total;
    const { destinationId, destinationName, destinationType, data, validityDays } = stored;

    tx.update(userRef, { balance: newBalance, lastEsimOrderId: orderId, updatedAt: serverTimestamp() });
    tx.set(orderRef, {
      uid, requestId,
      planId: planSnap.id,
      destinationId,
      destinationName,
      destinationType,
      data,
      validityDays,
      unitPrice, quantity: amount, total,
      // Where the store sends the QR/activation details for this order.
      email: String(user.email || profileSnap.data().email || "").slice(0, 160),
      status: "paid",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    // The plan's "sold" counter moves only with the order created in this same batch.
    tx.update(planRef, { sold: increment(amount), lastOrderId: orderId, updatedAt: serverTimestamp() });
    tx.set(doc(db, "users", uid, "transactions", `esim_${orderId}`), {
      type: "esim", title: `eSIM · ${destinationName.slice(0, 40)} · ${data.slice(0, 20)}`, amount: -total,
      status: "paid", orderId, balanceAfter: newBalance, createdAt: serverTimestamp()
    });
    tx.set(doc(db, "ledger", `esim_${orderId}`), {
      type: "esim", uid, amount: -total, balanceAfter: newBalance,
      reference: orderId, actor: uid, createdAt: serverTimestamp()
    });
    return {
      orderId, status: "paid", destinationName, data, unitPrice, quantity: amount,
      total, balance: newBalance, duplicate: false
    };
  });
}

const ESIM_ORDER_TRANSITIONS = {
  paid: ["processing", "cancelled"],
  processing: ["delivered", "cancelled"],
  delivered: [],
  cancelled: []
};
export const NEXT_ESIM_ACTIONS = {
  paid: [["processing", "Start delivery"], ["cancelled", "Cancel & refund"]],
  processing: [["delivered", "Mark delivered"], ["cancelled", "Cancel & refund"]],
  delivered: [],
  cancelled: []
};

// Admin moves an eSIM order forward — delivering it means the QR code / activation
// details have been sent, recorded in `instructions` so the customer can read them
// under My eSIMs — or cancels it, refunding the wallet in the same transaction.
export async function setEsimOrderStatus(orderId, status, { instructions = "" } = {}) {
  if (!["processing", "delivered", "cancelled"].includes(status)) {
    throw new Error("Status must be processing, delivered or cancelled.");
  }
  const note = String(instructions || "").trim().slice(0, 2000);
  const admin = auth.currentUser?.email || "admin";
  const orderRef = doc(db, "esimOrders", orderId);

  return runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("eSIM order not found.");
    const order = orderSnap.data();
    if (!ESIM_ORDER_TRANSITIONS[order.status]?.includes(status)) {
      throw new Error(`An eSIM order that is ${order.status} cannot be changed to ${status}.`);
    }

    if (status !== "cancelled") {
      const change = { status, updatedAt: serverTimestamp() };
      if (note) change.instructions = note;
      tx.update(orderRef, change);
      return { orderId, status };
    }

    const refund = Number(order.total || 0);
    const userRef = doc(db, "users", order.uid);
    const profileSnap = await tx.get(userRef);
    if (!profileSnap.exists()) throw new Error("The customer profile for this order does not exist.");
    const newBalance = Number(profileSnap.data().balance || 0) + refund;

    tx.update(userRef, { balance: newBalance, updatedAt: serverTimestamp() });
    tx.update(orderRef, { status: "cancelled", cancelledAt: serverTimestamp(), updatedAt: serverTimestamp() });
    tx.set(doc(db, "users", order.uid, "transactions", `esimrefund_${orderId}`), {
      type: "refund", title: `Refund · eSIM ${orderId.slice(-6).toUpperCase()}`, amount: refund,
      status: "refunded", orderId, balanceAfter: newBalance, createdAt: serverTimestamp()
    });
    tx.set(doc(db, "ledger", `esimrefund_${orderId}`), {
      type: "refund", uid: order.uid, amount: refund, balanceAfter: newBalance,
      reference: orderId, actor: admin, createdAt: serverTimestamp()
    });
    return { orderId, status: "cancelled", refunded: refund, balance: newBalance };
  });
}

export function watchMyEsimOrders(uid, callback, onError = noop) {
  return onSnapshot(query(collection(db, "esimOrders"), where("uid", "==", uid)), (snap) => {
    callback(rows(snap).sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)));
  }, onError);
}

export function watchAllEsimOrders(callback, onError = noop) {
  return onSnapshot(collection(db, "esimOrders"), (snap) => {
    callback(rows(snap).sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)));
  }, onError);
}

// One line of an eSIM order, for the customer's order history and the admin tables.
export function esimOrderLabel(order = {}) {
  return [order.destinationName, order.data, validityLabel(order.validityDays)].filter(Boolean).join(" · ");
}


// ---------- Analytics ----------
// Anonymous daily counters, with no personal data: a visit is a storefront page view, and
// a click is any element marked data-track. Admin accounts are not counted. Each counter
// only moves up by +1 and is checked by firestore.rules (analyticsDaily, analyticsLinks).
// Days are bucketed in Africa/Lagos so the admin "today" matches the store's clock.
const ANALYTICS_DAYS = "analyticsDaily";
const ANALYTICS_LINKS = "analyticsLinks";
const TRACK_LABEL = /^[a-z0-9-]{1,40}$/;
const WHATSAPP_LABEL = "whatsapp-channel";

export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function isAdminEmail(user) {
  return !!user && ADMIN_EMAILS.includes((user.email || "").trim().toLowerCase());
}

let visitCounted = false;
function countVisit() {
  if (visitCounted) return;
  visitCounted = true;
  auth.authStateReady().then(() => {
    if (isAdminEmail(auth.currentUser)) return null;
    return setDoc(doc(db, ANALYTICS_DAYS, dayKey()), { visits: increment(1) }, { merge: true });
  }).catch(noop);
}

export function recordLinkClick(label) {
  const key = String(label || "").toLowerCase();
  if (!TRACK_LABEL.test(key)) return Promise.resolve();
  const batch = writeBatch(db);
  const dailyField = key === WHATSAPP_LABEL ? "whatsappClicks" : "linkClicks";
  batch.set(doc(db, ANALYTICS_DAYS, dayKey()), { [dailyField]: increment(1) }, { merge: true });
  batch.set(doc(db, ANALYTICS_LINKS, key), { count: increment(1), label: key }, { merge: true });
  return batch.commit().catch(noop);
}

// One delegated listener for the whole site. Same-tab links wait briefly for the count to
// be saved, so a fast navigation does not lose the click.
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[data-track]") : null;
  if (!link) return;
  const pending = recordLinkClick(link.dataset.track);
  const plainClick = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  const sameTab = !link.target || link.target === "_self";
  if (plainClick && sameTab && link.href && new URL(link.href).origin === location.origin) {
    event.preventDefault();
    const href = link.href;
    Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 700))])
      .finally(() => { location.href = href; });
  }
});

// Admin reads.
export function watchAnalyticsDays(callback, onError = noop) {
  return onSnapshot(collection(db, ANALYTICS_DAYS), (snap) => callback(rows(snap)), onError);
}
export function watchAnalyticsLinks(callback, onError = noop) {
  return onSnapshot(collection(db, ANALYTICS_LINKS), (snap) => callback(rows(snap)), onError);
}

// ---------- Admin funding alerts ----------
// While an approved admin is signed in on any page, each new pending funding request raises
// a browser notification and an in-page toast. Like recommended-product alerts, a closed
// browser is only told on the next visit (there is no push server). The first run only
// records the current time, so older requests are not replayed.
const FUNDING_SEEN_KEY = "korastore-admin-funding-seen";
let stopFundingAlerts = null;

async function announceFunding(request) {
  let who = "A customer";
  try {
    const profile = await getDoc(doc(db, "users", request.uid));
    if (profile.exists()) who = profile.data().name || profile.data().email || who;
  } catch { /* the alert still fires without the name */ }
  const title = `Funding request · ${naira(request.amount)}`;
  const body = `${who} · Ref ${request.reference || "—"}. Confirm once the transfer lands.`;
  showToast(title, body);
  showBrowserNotification({
    title: `KORASTORE · ${title}`,
    body,
    tag: `funding-${request.id}`,
    link: new URL("admin-funding.html", location.href).href
  });
}

function startFundingAlerts() {
  let lastSeen = Number(localStorage.getItem(FUNDING_SEEN_KEY) || 0);
  if (!lastSeen) {
    lastSeen = Date.now();
    localStorage.setItem(FUNDING_SEEN_KEY, String(lastSeen));
  }
  const pending = query(collection(db, "fundingRequests"), where("status", "==", "pending"));
  return onSnapshot(pending, (snap) => {
    const now = Date.now();
    const fresh = rows(snap)
      .map((request) => ({ ...request, time: toDate(request.createdAt)?.getTime() || now }))
      .filter((request) => request.time > lastSeen)
      .sort((a, b) => a.time - b.time);
    if (!fresh.length) return;
    lastSeen = fresh.reduce((max, request) => Math.max(max, request.time), lastSeen);
    localStorage.setItem(FUNDING_SEEN_KEY, String(lastSeen));
    for (const request of fresh.slice(0, 5)) announceFunding(request);
  }, noop);
}

// Starts or stops the watcher as admins sign in and out. Firestore rules still decide what
// the listener may read; a signed-in admin with an unverified email just gets nothing.
onAuthStateChanged(auth, (user) => {
  if (isAdminEmail(user)) {
    if (!stopFundingAlerts) stopFundingAlerts = startFundingAlerts();
  } else if (stopFundingAlerts) {
    stopFundingAlerts();
    stopFundingAlerts = null;
  }
});
