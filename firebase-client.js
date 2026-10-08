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
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
// Analytics is optional and only runs in browser environments that support it.
if (typeof window !== "undefined") isSupported().then((supported) => { if (supported) getAnalytics(app); });
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
export { signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut };

// Creates /users/{uid} the first time a user signs in. Firestore creates the
// "users" collection automatically on this first write. Existing profiles are left untouched.
// Balance is never written from the browser; the server sets it.
export async function ensureUserProfile(user, name) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, {
    name: name || user.displayName || "",
    email: user.email,
    createdAt: serverTimestamp()
  });
}

// Live balance for the signed-in user. Returns an unsubscribe function.
export function watchWallet(uid, callback) {
  return onSnapshot(doc(db, "users", uid), (snap) => {
    callback(snap.exists() ? (snap.data().balance ?? 0) : 0);
  });
}

// Latest transactions for the signed-in user. Returns an unsubscribe function.
export function watchTransactions(uid, callback, max = 10) {
  const q = query(collection(db, "users", uid, "transactions"), orderBy("createdAt", "desc"), limit(max));
  return onSnapshot(q, (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
}

export async function getFirebaseToken() {
  if (!auth.currentUser) return null;
  return auth.currentUser.getIdToken();
}

// Use this for calls to the Render API. Wallet mutations must remain server-side.
export async function apiRequest(path, options = {}) {
  const token = await getFirebaseToken();
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}
