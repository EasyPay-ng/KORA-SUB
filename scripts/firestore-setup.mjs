// Server-side setup tool for KORASUB. Uses the Firebase Admin SDK, which bypasses security rules.
// Run locally or on a trusted machine only. Never ship the service account to the browser.
//
// Setup:
//   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json   (file is gitignored)
//
// Commands:
//   node scripts/firestore-setup.mjs set-admin <email>
//   node scripts/firestore-setup.mjs seed-wallet <email> <balance> [--name "Full Name"]
//
// Firestore creates the "users" and "transactions" collections automatically on first write.

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const [command, email, ...rest] = process.argv.slice(2);

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path first.");
  process.exit(1);
}

initializeApp({
  credential: applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID || "korasub-eb0b8"
});

const auth = getAuth();
const db = getFirestore();

async function userByEmail(address) {
  if (!address) throw new Error("An email address is required.");
  return auth.getUserByEmail(address);
}

async function setAdmin(address) {
  const user = await userByEmail(address);
  // Custom claims are read by security rules as request.auth.token.admin.
  await auth.setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true });
  console.log(`Granted admin claim to ${address} (uid ${user.uid}). The user must sign out and back in.`);
}

async function seedWallet(address, balanceArg, nameFlagArgs) {
  const user = await userByEmail(address);
  const balance = Number(balanceArg);
  if (!Number.isFinite(balance) || balance < 0) throw new Error("Balance must be a non-negative number.");
  const nameIdx = nameFlagArgs.indexOf("--name");
  const name = nameIdx >= 0 ? nameFlagArgs[nameIdx + 1] : user.displayName || "";

  // Creates /users/{uid} if missing and sets the balance. Merge keeps existing fields.
  const profileRef = db.collection("users").doc(user.uid);
  const existing = await profileRef.get();
  await profileRef.set(
    {
      name,
      email: user.email,
      balance,
      updatedAt: FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() })
    },
    { merge: true }
  );

  // Sample transaction history so the dashboard has something to show.
  const sample = [
    { title: "MTN 10GB Data", amount: -2400, status: "Successful", daysAgo: 0 },
    { title: "Wallet funding", amount: 10000, status: "Approved", daysAgo: 1 },
    { title: "Electricity token", amount: -5000, status: "Successful", daysAgo: 3 }
  ];
  const batch = db.batch();
  for (const tx of sample) {
    const ref = db.collection("users").doc(user.uid).collection("transactions").doc();
    const createdAt = new Date(Date.now() - tx.daysAgo * 86400000);
    batch.set(ref, { title: tx.title, amount: tx.amount, status: tx.status, createdAt });
  }
  await batch.commit();
  console.log(`Seeded wallet for ${address} (uid ${user.uid}): balance ${balance}, ${sample.length} transactions.`);
}

try {
  if (command === "set-admin") await setAdmin(email);
  else if (command === "seed-wallet") await seedWallet(email, rest[0], rest);
  else {
    console.log("Usage:\n  node scripts/firestore-setup.mjs set-admin <email>\n  node scripts/firestore-setup.mjs seed-wallet <email> <balance> [--name \"Full Name\"]");
    process.exit(1);
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exit(1);
}
