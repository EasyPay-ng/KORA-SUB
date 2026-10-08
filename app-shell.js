import { auth, onAuthStateChanged, signOut } from "./firebase-client.js";
import { initials } from "./app-utils.js";

export function bootApp(activePage) {
  const active = activePage || "dashboard.html";
  const userLabel = document.querySelector("[data-user-name]");
  const avatar = document.querySelector("[data-user-avatar]");
  const day = document.querySelector("[data-current-date]");
  if (day) day.textContent = new Intl.DateTimeFormat("en-NG", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  if (avatar) avatar.textContent = "KS";

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

  let stop = () => {};
  stop = onAuthStateChanged(auth, (user) => {
    if (!user) {
      stop();
      location.replace(`login.html?next=${encodeURIComponent(active)}`);
      return;
    }
    const display = user.displayName || user.email?.split("@")[0] || "there";
    if (userLabel) userLabel.textContent = display;
    if (avatar) avatar.textContent = initials(display);
    document.querySelectorAll(".side-link[data-page]").forEach((link) => {
      const selected = link.dataset.page === active;
      link.classList.toggle("active", selected);
      if (selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    document.dispatchEvent(new CustomEvent("korasub:authenticated", { detail: { user } }));
  });
  return () => stop();
}
