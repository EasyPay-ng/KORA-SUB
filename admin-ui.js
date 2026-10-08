import { auth, onAuthStateChanged, signOut } from "./firebase-client.js";
import { ADMIN_EMAIL } from "./firebase-config.js";
import { escapeHTML, initials } from "./app-utils.js";

const ADMIN_LINKS = [
  ["admin.html", "Overview", "⌂"],
  ["admin-funding.html", "Funding requests", "＋"],
  ["admin-ledger.html", "Wallet ledger", "▤"],
  ["admin-orders.html", "Orders & refunds", "↔"],
  ["admin-pricing.html", "Pricing & markup", "%"],
  ["admin-services.html", "Service settings", "⚙"]
];

function renderNavigation(activePage) {
  const host = document.querySelector("#admin-sidebar");
  if (!host) return;
  host.innerHTML = `
    <a class="brand side-brand" href="admin.html"><span class="brand-mark">K</span><span>KORASUB</span><small>ADMIN</small></a>
    <div class="side-label">WORKSPACE</div>
    <nav class="side-nav" aria-label="Admin navigation">
      ${ADMIN_LINKS.map(([href, label, icon]) => `
        <a class="side-link ${href === activePage ? "active" : ""}" href="${href}" ${href === activePage ? 'aria-current="page"' : ""}>
          <span class="side-icon" aria-hidden="true">${icon}</span><span>${label}</span>
        </a>`).join("")}
    </nav>
    <div class="side-bottom">
      <a class="side-link" href="dashboard.html"><span class="side-icon" aria-hidden="true">↗</span><span>Customer view</span></a>
      <button class="side-link side-signout" type="button" data-signout><span class="side-icon" aria-hidden="true">⇥</span><span>Sign out</span></button>
    </div>`;
}

function accessMessage(title, detail, type = "info") {
  const gate = document.querySelector("#access-message");
  if (!gate) return;
  gate.hidden = false;
  gate.className = `access-card ${type}`;
  gate.innerHTML = `<span class="access-symbol" aria-hidden="true">${type === "error" ? "!" : "i"}</span><div><b>${escapeHTML(title)}</b><p>${escapeHTML(detail)}</p></div>`;
}

export async function bootAdmin(activePage) {
  renderNavigation(activePage);
  const content = document.querySelector("#admin-content");
  const userName = document.querySelector("[data-user-name]");
  const userEmail = document.querySelector("[data-user-email]");
  const userAvatar = document.querySelector("[data-user-avatar]");
  accessMessage("Checking admin access", "Verifying your account and live data permissions.");

  document.querySelectorAll("[data-signout]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await signOut(auth);
        location.replace("index.html");
      } catch {
        button.disabled = false;
      }
    });
  });

  return new Promise((resolve) => {
    let stop = () => {};
    stop = onAuthStateChanged(auth, async (user) => {
      stop();
      if (!user) {
        location.replace(`login.html?next=${encodeURIComponent(activePage)}`);
        resolve(null);
        return;
      }
      if ((user.email || "").toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
        location.replace("dashboard.html");
        resolve(null);
        return;
      }

      let tokenResult;
      try {
        tokenResult = await user.getIdTokenResult(true);
      } catch {
        accessMessage("Could not verify admin access", "Refresh this page and sign in again.", "error");
        resolve(null);
        return;
      }
      if (tokenResult.claims.admin !== true) {
        accessMessage(
          "Admin authorization is not enabled",
          "This account needs the admin custom claim from the trusted Firebase Admin setup, then a fresh sign-in. No admin data is shown until that claim is present.",
          "error"
        );
        resolve(null);
        return;
      }

      if (userName) userName.textContent = user.displayName || user.email || "Administrator";
      if (userEmail) userEmail.textContent = user.email || "";
      if (userAvatar) userAvatar.textContent = initials(user.displayName || user.email);
      if (content) content.hidden = false;
      const gate = document.querySelector("#access-message");
      if (gate) gate.hidden = true;
      resolve(user);
    });
  });
}

export function showDataError(target, error, source = "Firebase") {
  if (!target) return;
  target.hidden = false;
  target.className = "inline-notice error-notice";
  target.textContent = `${source} could not be loaded: ${error?.message || "check access and connection"}`;
}

export function hideDataNotice(target) {
  if (target) target.hidden = true;
}
