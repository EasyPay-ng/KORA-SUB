// One-time admin setup for KORASTORE. Uses the Firebase Admin SDK on a trusted machine only.
// Never ship the service-account key to the browser or commit it.
//
// Setup:
//   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json   (file is gitignored)
//
// Command:
//   node scripts/firestore-setup.mjs set-admin beniwealth70@gmail.com
//
// The admin must sign out and back in after the claim is set, so the new token carries it.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const [command, email] = process.argv.slice(2);
const ADMIN_EMAIL = "beniwealth70@gmail.com";

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path first.");
  process.exit(1);
}

initializeApp({
  credential: applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID || "korasub-eb0b8"
});

const auth = getAuth();

async function setAdmin(address) {
  if (!address) throw new Error("An email address is required.");
  if (address.toLowerCase() !== ADMIN_EMAIL) {
    throw new Error(`Only ${ADMIN_EMAIL} can be the store administrator.`);
  }
  const user = await auth.getUserByEmail(address);
  if (!user.emailVerified) throw new Error("Verify this email address before granting admin access.");
  await auth.setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true });
  console.log(`Granted admin claim to ${address} (uid ${user.uid}). Sign out and back in to refresh the token.`);
}

try {
  if (command === "set-admin") await setAdmin(email);
  else {
    console.log("Usage:\n  node scripts/firestore-setup.mjs set-admin beniwealth70@gmail.com");
    process.exit(1);
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exit(1);
}
