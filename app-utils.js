export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

export function numberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatMoney(value, digits = 2) {
  const amount = numberValue(value);
  return `₦${Math.abs(amount).toLocaleString("en-NG", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}`;
}

export function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  if (typeof value._seconds === "number") return new Date(value._seconds * 1000);
  return null;
}

export function formatDate(value, options = {}) {
  const date = toDate(value);
  if (!date) return "Not recorded";
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...options
  }).format(date);
}

export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return "Not recorded";
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function relativeTime(value) {
  const date = toDate(value);
  if (!date) return "Date not recorded";
  const delta = date.getTime() - Date.now();
  const minutes = Math.round(delta / 60000);
  const hours = Math.round(delta / 3600000);
  const days = Math.round(delta / 86400000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  if (Math.abs(days) < 7) return formatter.format(days, "day");
  return formatDate(value);
}

export function initials(value) {
  const parts = String(value || "").trim().split(/[\s@._-]+/).filter(Boolean);
  if (!parts.length) return "KS";
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}

export function statusTone(value) {
  const status = String(value || "").toLowerCase();
  if (/success|complete|approved|delivered|paid|active/.test(status)) return "success";
  if (/fail|reject|refund|cancel|declin|error/.test(status)) return "danger";
  if (/pending|processing|review|queued/.test(status)) return "warning";
  return "neutral";
}

export function transactionStatus(value) {
  return String(value || "Status not supplied");
}

export function recordDate(record) {
  return record?.createdAt || record?.created_at || record?.timestamp || record?.date || null;
}

export function recordAmount(record) {
  return numberValue(record?.amount ?? record?.value ?? record?.total ?? record?.price ?? 0);
}

export function personLabel(user) {
  return user?.name || user?.displayName || user?.email || "Customer";
}
