// Firebase web configuration is safe to ship in the browser. Never put the service-account key here.
export const firebaseConfig = {
  apiKey: "AIzaSyCQL4NP-pj0wLmF_9IuesZiQQZTj26QBSY",
  authDomain: "korasub-eb0b8.firebaseapp.com",
  projectId: "korasub-eb0b8",
  storageBucket: "korasub-eb0b8.firebasestorage.app",
  messagingSenderId: "284675772618",
  appId: "1:284675772618:web:0e7df5d4bd1bd8b4236433",
  measurementId: "G-L1CY5KJH11"
};

export const ADMIN_EMAIL = "beniwealth70@gmail.com";
// Deployed Worker URL ending in /api (or a same-origin /api proxy).
// Public Worker origin only. Secrets live in Wrangler secrets, never in browser code.
export const API_BASE = "https://kora-sub.owanaomubo80.workers.dev/api";
