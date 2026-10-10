// Firebase web configuration is safe to ship in the browser. Security comes from firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyCQL4NP-pj0wLmF_9IuesZiQQZTj26QBSY",
  authDomain: "korasub-eb0b8.firebaseapp.com",
  projectId: "korasub-eb0b8",
  storageBucket: "korasub-eb0b8.firebasestorage.app",
  messagingSenderId: "284675772618",
  appId: "1:284675772618:web:0e7df5d4bd1bd8b4236433",
  measurementId: "G-L1CY5KJH11"
};

// Every address in this list has full admin rights: the admin console screens and, more
// importantly, everything isAdmin() allows in firestore.rules.
//
// Keep this list and isAdmin() in firestore.rules in sync. This file is only the
// on-page gate — firestore.rules is the real one, and a mismatch here just means the
// admin screens are hidden or shown for the wrong person.
export const ADMIN_EMAILS = [
  "beniwealth70@gmail.com",
  "okogbagideon28@gmail.com",
];

// The primary admin address, used for the customer-facing "Contact" link.
export const ADMIN_EMAIL = ADMIN_EMAILS[0];

// Case-insensitive membership test, so a Google sign-in that returns the address with
// different casing still passes.
export function isAdminEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  return value !== "" && ADMIN_EMAILS.some((address) => address.toLowerCase() === value);
}
