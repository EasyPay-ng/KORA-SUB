import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  collectionGroup,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig, API_BASE } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
// Analytics is optional; the app still works if analytics is blocked or unsupported.
if (typeof window !== "undefined") {
  isSupported().then((supported) => {
    if (supported) getAnalytics(app);
  }).catch(() => {});
}

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
export {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  onAuthStateChanged,
  signOut
};

const noop = () => {};

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value) || 0;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value._seconds === "number") return value._seconds * 1000;
  return 0;
}

function snapshotRows(snapshot) {
  return snapshot.docs.map((item) => ({ ...item.data(), id: item.id }));
}

// Creates /users/{uid} only when a profile does not yet exist. Wallet fields are
// deliberately omitted: the browser must never create or change a balance.
export async function ensureUserProfile(user, name) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, {
    name: name || user.displayName || "",
    email: user.email || "",
    createdAt: serverTimestamp()
  });
}

// Live balance for the signed-in user. Returns an unsubscribe function.
export function watchWallet(uid, callback, onError = noop) {
  return onSnapshot(doc(db, "users", uid), (snap) => {
    callback(snap.exists() ? (snap.data().balance ?? 0) : 0);
  }, onError);
}

// Latest transactions for the signed-in user. Returns an unsubscribe function.
export function watchTransactions(uid, callback, max = 10, onError = noop) {
  const q = query(
    collection(db, "users", uid, "transactions"),
    orderBy("createdAt", "desc"),
    limit(max)
  );
  return onSnapshot(q, (snap) => callback(snapshotRows(snap)), onError);
}

// Customers may submit a funding request, but cannot approve it or credit a wallet.
export function watchFundingRequests(uid, callback, onError = noop) {
  const q = query(collection(db, "fundingRequests"), where("uid", "==", uid));
  return onSnapshot(q, (snap) => {
    const rows = snapshotRows(snap);
    rows.sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt));
    callback(rows);
  }, onError);
}

export function createFundingRequest(uid, amount, reference) {
  return addDoc(collection(db, "fundingRequests"), {
    uid,
    amount: Number(amount),
    reference: String(reference).trim(),
    status: "pending",
    createdAt: serverTimestamp()
  });
}

// Admin feeds are read-only in the browser. Mutations to balances, ledger,
// funding approvals and refunds must be performed by a trusted server.
export function watchAdminUsers(callback, onError = noop) {
  return onSnapshot(collection(db, "users"), (snap) => callback(snapshotRows(snap)), onError);
}

export function watchAdminFundingRequests(callback, onError = noop) {
  return onSnapshot(collection(db, "fundingRequests"), (snap) => callback(snapshotRows(snap)), onError);
}

export function watchAdminLedger(callback, onError = noop) {
  return onSnapshot(collection(db, "ledger"), (snap) => callback(snapshotRows(snap)), onError);
}

export function watchAdminTransactions(callback, onError = noop) {
  return onSnapshot(collectionGroup(db, "transactions"), (snap) => {
    const rows = snap.docs.map((item) => {
      const path = item.ref.path.split("/");
      return { ...item.data(), id: item.id, uid: path[1] || "" };
    });
    rows.sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt));
    callback(rows);
  }, onError);
}

export async function getFirebaseToken() {
  if (!auth.currentUser) return null;
  return auth.currentUser.getIdToken();
}

// Calls the same-origin API proxy. Provider credentials stay on the server.
export async function apiRequest(path, options = {}) {
  const token = await getFirebaseToken();
  const base = String(API_BASE || "/api").replace(/\/$/, "");
  const route = String(path || "").startsWith("/") ? path : `/${path}`;
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
  return data;
}
