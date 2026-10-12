// KORASTORE shared client: Firebase Auth/Firestore, checkout and admin transactions, cart, formatting and page shells.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, collection, query, where,
  orderBy, limit, onSnapshot, serverTimestamp, runTransaction, writeBatch
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

// Saves (or clears, with null) the pickup station this customer orders to. Stored on the
// profile so checkout always shows — and charges for — the station they last chose.
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
// else in Nigeria (and abroad) uses the nationwide rate. A pickup order is charged by
// the station's state exactly like a doorstep delivery to that state.
export function checkoutFees(subtotal, delivery, fees = DEFAULT_FEES) {
  const items = Math.round(Number(subtotal) || 0);
  const serviceFee = Math.max(0, Math.round(Number(fees.serviceFee) || 0));
  const picked = delivery?.method === "pickup";
  const country = PICKUP_COUNTRY;
  const state = String(delivery?.state || "").trim();
  const localState = String(fees.localState || DEFAULT_FEES.localState).trim();
  const local = !!state && state === localState;
  const deliveryFee = Math.max(0, Math.round(Number(local ? fees.deliveryLocal : fees.deliveryNigeria) || 0));
  const deliveryLabel = local
    ? `Pickup · ${localState}`
    : (state ? `Pickup · ${state}` : "Pickup at a station");
  return {
    subtotal: items,
    serviceFee,
    deliveryFee,
    deliveryLabel,
    // Whether the cheaper local pickup rate applies (shown in the cart summary).
    deliveryLocal: local,
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

// ---------- Pickup stations ----------
// Orders are collected at a pickup station instead of a doorstep address: the customer
// picks their state, then the station closest to them. The catalogue lives in Firestore
// — pickupStations/{stationId}, seeded from data/jumia-pickup-stations.json by
// Admin → Pickup stations — so the security rules can pin an order to a real station
// (and to the station's own state, which decides the delivery fee).
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
// Checks the pickup station the order delivers to. The station's own document decides the
// name, state and address on the order (and the state decides the delivery fee); the
// security rules read the same document again, so an order can only carry a real station.
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
        <div class="footer-links"><a href="shop.html">Shop</a><a href="boost.html">Boost</a><a href="wallet.html">Fund wallet</a><a href="orders.html">Orders</a><a href="mailto:beniwealth70@gmail.com">Contact</a></div>
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
  ["admin-products.html", "Products", "▣"],
  ["admin-boost.html", "Boosting", "↗"],
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

// ---------- Social media boosting ----------
// The admin runs a boosting catalogue: platforms (Facebook, TikTok, YouTube, …),
// categories inside them (Followers, Likes, Views, …), and plans — the actual
// service listings, each with its own price per unit, optional min/max quantity
// and an average delivery time. Shoppers see one order form (Category → Plan →
// link → quantity → pay from wallet); there is no delivery and no checkout fee on
// boost orders.
export const BOOST_ID_PATTERN = /^[A-Za-z0-9_-]{2,40}$/;
// Hard ceiling for any boost quantity. A plan can narrow it with minQuantity /
// maxQuantity (maxQuantity 0 or missing means "no maximum").
export const BOOST_MAX_QUANTITY = 100000;
// Smallest price per unit the admin can set: ₦0.10 (cheap units such as views).
// The wallet only ever holds whole naira, so all boost money is worked out in
// kobo (exact integers) and an order total is rounded to the nearest naira.
export const BOOST_MIN_UNIT_PRICE = 0.1;

// Effective order limits for a plan, honouring the catalogue fields when set.
export function boostServiceLimits(service = {}) {
  const minRaw = Number(service.minQuantity);
  const min = Number.isInteger(minRaw) && minRaw >= 1 ? Math.min(minRaw, BOOST_MAX_QUANTITY) : 1;
  const maxRaw = Number(service.maxQuantity);
  const max = Number.isInteger(maxRaw) && maxRaw >= min ? Math.min(maxRaw, BOOST_MAX_QUANTITY) : BOOST_MAX_QUANTITY;
  return { min, max };
}

// "Twitter" + "Views" → "Twitter Views" (without doubling when the category name
// already starts with the platform name). Used anywhere a category is picked.
export function boostCategoryTitle(platform, category) {
  const platformName = String(platform?.name || '').trim();
  const categoryName = String(category?.name || '').trim() || 'Category';
  if (!platformName) return categoryName;
  return categoryName.toLowerCase().startsWith(platformName.toLowerCase())
    ? categoryName
    : `${platformName} ${categoryName}`;
}

// "Min: 100 | Max: 2,000,000" (the max is hidden when the plan sets none).
export function formatBoostLimits(service = {}) {
  const { min, max } = boostServiceLimits(service);
  const low = `Min: ${min.toLocaleString('en-NG')}`;
  return max >= BOOST_MAX_QUANTITY ? low : `${low} | Max: ${max.toLocaleString('en-NG')}`;
}

// A plan's price per unit, as whole kobo (₦1 = 100). Working in kobo keeps the
// maths exact for the cheap fractional prices (₦0.1, ₦0.15, …) the admin can set.
// Returns 0 when the price is unusable.
export function boostPriceKobo(price) {
  const amount = Number(price);
  if (!Number.isFinite(amount)) return 0;
  const kobo = Math.round(amount * 100);
  return Number.isSafeInteger(kobo) && kobo >= 1 ? kobo : 0;
}

// Reads an admin-typed price ("17", "0.5", "12.30") as a number, or null when it
// is not a valid boost price (at least ₦0.10, at most two decimals).
export function parseBoostPrice(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return null;
  const kobo = boostPriceKobo(text);
  if (!kobo || kobo < boostPriceKobo(BOOST_MIN_UNIT_PRICE)) return null;
  return kobo / 100;
}

// What a boost order costs: price per unit × quantity, in kobo, rounded to the
// nearest naira because the wallet is whole naira — never below ₦1. Returns 0
// when the price or the quantity is unusable (so callers can reject the order).
export function boostOrderTotal(price, quantity) {
  const kobo = boostPriceKobo(price);
  const units = Number(quantity);
  if (!kobo || kobo < boostPriceKobo(BOOST_MIN_UNIT_PRICE)) return 0;
  if (!Number.isSafeInteger(units) || units < 1 || units > BOOST_MAX_QUANTITY) return 0;
  const total = Math.round((kobo * units) / 100);
  return total < 1 ? 1 : total;
}

// "₦0.10" for a sub-₦1 price, "₦17" when the price is a whole naira amount.
export function formatBoostPrice(price) {
  const kobo = boostPriceKobo(price);
  if (!kobo) return naira(0);
  const whole = Math.floor(kobo / 100);
  const rest = kobo % 100;
  return rest ? `₦${whole.toLocaleString('en-NG')}.${String(rest).padStart(2, '0')}` : naira(whole);
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

// Buys one boosting service: the catalogue's price × quantity, paid from the wallet.
// The order id is "<uid>_<requestId>", so a retried checkout returns the original
// order instead of charging twice.
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

    const unitPrice = Number(service.price);
    if (!boostPriceKobo(unitPrice) || unitPrice < BOOST_MIN_UNIT_PRICE) throw new Error("This service has no valid price.");
    // The plan's own limits, read inside the transaction so they cannot be stale.
    const { min, max } = boostServiceLimits(service);
    if (amount < min) throw new Error(`This plan needs a quantity of at least ${min.toLocaleString('en-NG')}.`);
    if (amount > max) throw new Error(`This plan allows a quantity of at most ${max.toLocaleString('en-NG')}.`);
    // Price × quantity in kobo, rounded to whole naira (the wallet holds no kobo).
    const total = boostOrderTotal(unitPrice, amount);
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
      unitPrice, quantity: amount, total,
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
      orderId, status: "paid", unitPrice, quantity: amount,
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
