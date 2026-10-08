const ARRAY_KEYS = [
  "categories", "services", "plans", "products", "items", "results", "records", "data", "response"
];

function unwrapArray(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 5) return null;

  for (const key of ARRAY_KEYS) {
    if (key in value) {
      const result = unwrapArray(value[key], depth + 1);
      if (result) return result;
    }
  }

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) return nested;
    if (nested && typeof nested === "object") {
      const result = unwrapArray(nested, depth + 1);
      if (result) return result;
    }
  }

  const values = Object.values(value);
  if (values.length && values.every((item) => typeof item === "string" || (item && typeof item === "object"))) {
    return values;
  }
  return null;
}

function firstValue(record, fields) {
  for (const field of fields) {
    const value = record?.[field];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

export function normalizeRecords(payload, kind = "service") {
  const list = unwrapArray(payload) || [];
  return list.map((item, index) => {
    const record = typeof item === "string" ? { name: item } : (item || {});
    const name = firstValue(record, [
      "displayName", "name", "title", "serviceName", "categoryName", "planName", "productName", "label", "description", "service", "category"
    ]) || `${kind === "plan" ? "Plan" : "Service"} ${index + 1}`;
    const id = firstValue(record, [
      "serviceID", "serviceId", "categoryID", "categoryId", "planID", "planId", "productID", "productId", "id", "code", "value"
    ]) || name;
    return { ...record, _displayName: String(name), _recordId: String(id) };
  });
}

export function normalizeServices(payload) {
  const groups = unwrapArray(payload) || [];
  const services = [];
  const addService = (item, groupValue = "Other") => {
    const record = typeof item === "string" ? { displayName: item, serviceID: item } : (item || {});
    const name = firstValue(record, ["displayName", "name", "title", "serviceName", "label"]);
    const id = firstValue(record, ["serviceID", "serviceId", "id", "code", "value"]);
    if (!name && !id) return;
    const category = String(groupValue || record.category || "Other");
    const normalizedId = String(id || name);
    const group = category.toLowerCase();
    const serviceId = normalizedId.toLowerCase();
    const pricingMode = group.includes("airtime") || ["mtn", "airtel", "glo", "etisalat"].includes(serviceId)
      ? "amount"
      : group.includes("electric") || serviceId.includes("electric") ? "meter" : "plans";
    services.push({
      ...record,
      category,
      pricingMode,
      _displayName: String(name || id),
      _recordId: normalizedId
    });
  };

  for (const item of groups) {
    if (!item || typeof item !== "object") {
      addService(item);
      continue;
    }
    const groupName = firstValue(item, ["displayName", "name", "categoryName", "title"]) || "Other";
    const nested = Array.isArray(item.services) ? item.services
      : Array.isArray(item.items) ? item.items
        : Array.isArray(item.children) ? item.children : null;
    if (nested) nested.forEach(service => addService(service, groupName));
    else addService(item, groupName);
  }
  return services;
}

export function recordField(record, fields) {
  return firstValue(record, fields);
}

export function priceValue(record) {
  return firstValue(record, [
    "sellingPrice", "retailPrice", "customerPrice", "price", "amount", "cost", "providerPrice", "productPrice"
  ]);
}

export function parsePrice(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object") {
    for (const key of ["NGN", "ngn", "amount", "value", "price"]) {
      if (value[key] !== undefined) {
        const parsed = parsePrice(value[key]);
        if (parsed !== null) return parsed;
      }
    }
    return null;
  }
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const cleaned = String(value).replace(/[^\d.-]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function apiPriceValue(record) {
  return firstValue(record, ["api_price", "apiPrice", "providerPrice", "cost"]);
}

export function markupValue(record) {
  return firstValue(record, ["markup", "markupAmount", "markupPercent", "markupPercentage", "margin"]);
}

export function serviceStatus(record) {
  const status = firstValue(record, ["status", "enabled", "active", "isActive", "available"]);
  if (status === "") return "Not provided by API";
  if (typeof status === "boolean") return status ? "Enabled" : "Paused";
  const text = String(status).toLowerCase();
  if (["true", "1", "enabled", "active", "available", "on"].includes(text)) return "Enabled";
  if (["false", "0", "disabled", "inactive", "unavailable", "off"].includes(text)) return "Paused";
  return String(status);
}
