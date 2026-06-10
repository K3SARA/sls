import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { calculateTotals, PAYMENT_TYPES, SOCKET_EVENTS } from "@pepsi/shared";
import {
  clearAuthSession,
  createAuthUser,
  fetchAuthUsers,
  createCustomer,
  createProduct,
  createStaff,
  deleteAuthUser,
  deleteSale,
  deleteStaff,
  deleteProduct,
  fetchAppConfig,
  fetchDashboard,
  fetchMe,
  fetchState,
  getAccessToken,
  getApiBase,
  loginApi,
  logoutApi,
  patchSale,
  patchProduct,
  setAuthCallbacks,
  setAuthSession,
  submitDeliveryAdjustment,
  submitReturn,
  submitSale,
  setManagerFullAccess,
  updateCustomer,
  updateAuthUser,
  updateStaff,
  resetLorryCount,
  setLoadingRowMark
} from "./api.js";

const formatLkrValue = (value) => Number(value || 0).toLocaleString("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const currency = (value) => `LKR ${formatLkrValue(value)}`;
const SESSION_KEY = "pepsi_pos_session";
const BUSINESS_TIME_ZONE = "Asia/Colombo";
const colomboDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
const colomboTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});
const escapeHtml = (value = "") => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

const BUNDLE_BY_SIZE_ML = {
  200: 24,
  250: 30,
  300: 24,
  400: 24,
  1000: 12,
  1500: 12,
  2000: 9
};
const BASE_LORRIES = ["Lorry A", "Lorry B"];
const ORDER_LORRIES = ["Lorry A", "Lorry A Overflow", "Lorry B", "Lorry B Overflow"];
const LOADING_PANEL_CONFIG = [
  { name: "Lorry A", sortKey: "loadingA", className: "loading-lorry-a" },
  { name: "Lorry A Overflow", sortKey: "loadingAOverflow", className: "loading-lorry-a loading-lorry-overflow" },
  { name: "Lorry B", sortKey: "loadingB", className: "loading-lorry-b" },
  { name: "Lorry B Overflow", sortKey: "loadingBOverflow", className: "loading-lorry-b loading-lorry-overflow" }
];
const buildLoadingMarkKey = ({ lorry, rowKey, dateFrom, timeFrom, dateTo, timeTo }) => [
  String(lorry || "").trim(),
  String(rowKey || "").trim(),
  String(dateFrom || "").trim(),
  String(timeFrom || "").trim(),
  String(dateTo || "").trim(),
  String(timeTo || "").trim()
].join("|");

const extractSizeMl = (value = "") => {
  const raw = String(value || "").toLowerCase().replace(/\s+/g, "");
  const match = raw.match(/(\d{3,4})ml/);
  return match ? Number(match[1]) : 0;
};

const getBundleSize = (item) => {
  const name = String(item?.name || item || "").toLowerCase();
  const category = String(item?.category || "").toLowerCase();
  const sizeMl = extractSizeMl(item?.size || name);
  const isWater = name.includes("water") || category.includes("water") || name.includes("aquafina");

  if (!sizeMl) return 0;
  if (isWater && sizeMl === 1000) return 15;
  if (isWater && sizeMl === 1500) return 12;
  if (isWater && sizeMl === 500) return 24;
  return BUNDLE_BY_SIZE_ML[sizeMl] || 0;
};

const bundleRuleLabel = (item) => {
  const name = String(item?.name || item || "").toLowerCase();
  const category = String(item?.category || "").toLowerCase();
  const sizeMl = extractSizeMl(item?.size || name);
  const bundleSize = getBundleSize(item);
  const isWater = name.includes("water") || category.includes("water") || name.includes("aquafina");
  if (!sizeMl || !bundleSize) return "";
  return `${isWater ? "Water " : ""}${sizeMl} ml = ${bundleSize} per bundle`;
};

const productDisplayName = (product) => {
  const name = String(product?.name || "").trim();
  const size = String(product?.size || "").trim();
  return size ? `${name} ${size}` : name;
};
const toColomboDateKey = (value = new Date()) => {
  try {
    return colomboDateFormatter.format(new Date(value));
  } catch {
    return "";
  }
};
const toColomboTimeKey = (value = new Date()) => {
  try {
    return colomboTimeFormatter.format(new Date(value));
  } catch {
    return "";
  }
};
const isChequePaymentPending = (payment, referenceDate = new Date()) => {
  if (String(payment?.method || "").toLowerCase() !== "cheque") return false;
  const chequeDateKey = toColomboDateKey(payment?.chequeDate);
  if (!chequeDateKey) return false;
  const todayKey = toColomboDateKey(referenceDate);
  if (!todayKey) return false;
  return chequeDateKey > todayKey;
};
const scrollViewportToTop = () => {
  if (typeof window === "undefined") return;
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
};
const getBundleBreakdown = (row) => {
  const bundleSize = getBundleSize(row);
  const qty = Number(row?.qty || 0);
  if (!bundleSize) return { bundles: 0, singles: qty };
  return { bundles: Math.floor(qty / bundleSize), singles: qty % bundleSize };
};
const startOfLocalDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};
const addDays = (value, days) => {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
};
const customerOutstandingAging = (sale) => {
  if (!sale) return { daysLeft: null, label: "-" };
  const rawDue = String(sale.creditDueDate || "").trim();
  const dueDate = rawDue ? startOfLocalDay(rawDue) : startOfLocalDay(addDays(sale.createdAt || new Date().toISOString(), 15));
  const today = startOfLocalDay();
  const diffDays = Math.round((dueDate.getTime() - today.getTime()) / 86400000);
  if (diffDays >= 0) {
    return { daysLeft: diffDays, label: `${diffDays} days left` };
  }
  return { daysLeft: diffDays, label: `Overdue by ${Math.abs(diffDays)} days` };
};
const productSalePrice = (product) => Number(product?.billingPrice ?? product?.price ?? product?.mrp ?? 0);
const lineBasePrice = (line) => Number(line?.basePrice ?? line?.price ?? 0);
const lineStoredDiscountAmount = (line) => {
  const base = lineBasePrice(line);
  const explicitAmount = Number(line?.itemDiscountAmount || 0);
  if (Number.isFinite(explicitAmount) && explicitAmount > 0) return Math.min(base, explicitAmount);
  const storedPrice = Number(line?.price);
  if (Number.isFinite(storedPrice) && base > 0 && storedPrice >= 0 && storedPrice < base) {
    return Number((base - storedPrice).toFixed(2));
  }
  return 0;
};
const lineItemDiscount = (line) => {
  const raw = Number(line?.itemDiscount || 0);
  const base = lineBasePrice(line);
  const storedAmount = lineStoredDiscountAmount(line);
  if (storedAmount > 0) return storedAmount;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (String(line?.itemDiscountMode || "amount") === "percent") {
    const percent = Math.min(raw, 100);
    return Number(((base * percent) / 100).toFixed(2));
  }
  return Math.min(raw, base);
};
const lineFinalPrice = (line) => Math.max(0, lineBasePrice(line) - Math.max(0, lineItemDiscount(line)));
const editableLineDiscountValue = (line) => {
  const base = lineBasePrice(line);
  const mode = String(line?.itemDiscountMode || "amount");
  const raw = Number(line?.itemDiscount || 0);
  const applied = lineStoredDiscountAmount(line);
  if (mode === "percent") {
    if (applied > 0 && base > 0) return Number(((applied / base) * 100).toFixed(2));
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(raw, 100);
  }
  if (applied > 0) return applied;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, base);
};
const billDiscountValue = (discountMode, discountValue, lines) => {
  const raw = Number(discountValue || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const subTotal = Number((lines || []).reduce((acc, line) => acc + (Number(line.price || 0) * Number(line.quantity || 0)), 0).toFixed(2));
  if (String(discountMode || "amount") === "percent") {
    const clamped = Math.min(raw, 100);
    return Number(((subTotal * clamped) / 100).toFixed(2));
  }
  return Number(raw.toFixed(2));
};
const totalDiscountApplied = ({ lines = [], billDiscount = 0 }) => {
  const lineDiscountTotal = Number((lines || []).reduce((acc, line) => {
    const qty = Number(line?.quantity || 0);
    return acc + (lineItemDiscount(line) * Math.max(0, qty));
  }, 0).toFixed(2));
  return Number((lineDiscountTotal + Math.max(0, Number(billDiscount || 0))).toFixed(2));
};
const findBundleDiscountViolation = ({ lines = [], bundleDiscountLimit = 0 }) => {
  const limit = Number(Number(bundleDiscountLimit || 0).toFixed(2));
  if (!(limit > 0)) return null;
  for (const line of (lines || [])) {
    const qty = Math.max(0, Number(line?.quantity || 0));
    const bundleSize = getBundleSize(line);
    if (!(bundleSize > 0) || qty < bundleSize) continue;
    const fullBundles = Math.floor(qty / bundleSize);
    const unitDiscount = Number(Number(lineItemDiscount(line) || 0).toFixed(2));
    if (!(fullBundles > 0) || !(unitDiscount > 0)) continue;
    const actualBundleDiscount = Number((unitDiscount * fullBundles * bundleSize).toFixed(2));
    const allowedBundleDiscount = Number((fullBundles * limit).toFixed(2));
    if (actualBundleDiscount > allowedBundleDiscount) {
      return {
        lineName: String(line?.name || "").trim() || "Item",
        fullBundles,
        actualBundleDiscount,
        allowedBundleDiscount
      };
    }
  }
  return null;
};
const salePayments = (sale) => {
  const explicit = Array.isArray(sale?.payments) ? sale.payments : [];
  if (explicit.length) return explicit;
  const migrated = [];
  if (Number(sale?.cashReceived || 0) > 0) {
    migrated.push({
      id: `legacy-cash-${sale?.id || "sale"}`,
      method: "cash",
      amount: Number(sale.cashReceived || 0),
      createdAt: sale?.deliveryConfirmedAt || sale?.createdAt || new Date().toISOString(),
      receivedBy: sale?.deliveryConfirmedBy || sale?.cashier || "-"
    });
  }
  if (Number(sale?.chequeAmount || 0) > 0) {
    migrated.push({
      id: `legacy-cheque-${sale?.id || "sale"}`,
      method: "cheque",
      amount: Number(sale.chequeAmount || 0),
      chequeNo: sale?.chequeNo || "",
      chequeDate: sale?.chequeDate || "",
      chequeBank: sale?.chequeBank || "",
      createdAt: sale?.deliveryConfirmedAt || sale?.createdAt || new Date().toISOString(),
      receivedBy: sale?.deliveryConfirmedBy || sale?.cashier || "-"
    });
  }
  return migrated;
};
const saleDisplayPaymentInfo = (sale) => {
  const payments = salePayments(sale).filter((payment) => Number(payment.amount || 0) > 0);
  const methods = [...new Set(payments.map((payment) => String(payment.method || "").toLowerCase()).filter(Boolean))];
  if (!methods.length) {
    const fallbackType = String(sale?.paymentType || "").trim().toLowerCase();
    return {
      label: String(sale?.paymentType || "").toUpperCase() || "-",
      detail: fallbackType === "credit" && sale?.creditDueDate ? `DUE ${sale.creditDueDate}` : ""
    };
  }
  if (methods.length === 1) {
    const method = methods[0];
    if (method === "cheque") {
      const latestCheque = [...payments].reverse().find((payment) => String(payment.method || "").toLowerCase() === "cheque");
      const detailParts = [];
      if (latestCheque?.chequeDate) detailParts.push(`DATE ${latestCheque.chequeDate}`);
      if (latestCheque?.chequeNo) detailParts.push(`NO ${latestCheque.chequeNo}`);
      return {
        label: "CHEQUE",
        detail: detailParts.join(" • ")
      };
    }
    if (method === "customer_credit") {
      return {
        label: "CUSTOMER CREDIT",
        detail: ""
      };
    }
    return {
      label: method.toUpperCase(),
      detail: ""
    };
  }
  return {
    label: "MIXED",
    detail: methods.map((method) => method === "customer_credit" ? "CUSTOMER CREDIT" : method.toUpperCase()).join(" + ")
  };
};
const returnLinePreview = (sale, line, quantity = 0) => {
  const qty = Number(quantity || 0);
  const soldQty = Number(line?.quantity || 0);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(soldQty) || soldQty <= 0) {
    return { grossAmount: 0, billDiscountShare: 0, returnAmount: 0, unitAmount: 0 };
  }
  const soldUnitPrice = Number(line?.price || 0);
  const grossAmount = Number((soldUnitPrice * qty).toFixed(2));
  const saleSubTotal = Number(sale?.subTotal || 0);
  const billDiscountShare = saleSubTotal > 0
    ? Number((Number(sale?.discountAmount || sale?.discount || 0) * (grossAmount / saleSubTotal)).toFixed(2))
    : 0;
  const returnAmount = Number(Math.max(0, grossAmount - billDiscountShare).toFixed(2));
  return {
    grossAmount,
    billDiscountShare,
    returnAmount,
    unitAmount: qty > 0 ? Number((returnAmount / qty).toFixed(2)) : 0
  };
};
const deliveryAdjustmentAmount = (sale, draft = {}) => {
  if (!sale) return 0;
  const qtyByProduct = new Map();
  for (const adj of (sale.deliveryAdjustments || [])) {
    for (const line of (adj.lines || [])) {
      const key = String(line.productId || "").trim();
      if (!key) continue;
      qtyByProduct.set(key, Number(qtyByProduct.get(key) || 0) + Number(line.quantity || 0));
    }
  }
  Object.entries(draft || {}).forEach(([productId, quantity]) => {
    const key = String(productId || "").trim();
    if (!key) return;
    const qty = Number(quantity || 0);
    if (!Number.isFinite(qty) || qty <= 0) return;
    qtyByProduct.set(key, Number(qtyByProduct.get(key) || 0) + qty);
  });

  let total = 0;
  for (const line of (sale.lines || [])) {
    const key = String(line.productId || "").trim();
    if (!key) continue;
    const soldQty = Number(line.quantity || 0);
    const undeliveredQty = Math.min(soldQty, Number(qtyByProduct.get(key) || 0));
    if (undeliveredQty <= 0) continue;
    total += Number(returnLinePreview(sale, line, undeliveredQty).returnAmount || 0);
  }
  return Number(total.toFixed(2));
};
const saleUndeliveredQtyByProduct = (sale) => {
  const map = new Map();
  for (const adjustment of (sale?.deliveryAdjustments || [])) {
    for (const line of (adjustment.lines || [])) {
      const key = String(line.productId || "").trim();
      if (!key) continue;
      map.set(key, Number(map.get(key) || 0) + Number(line.quantity || 0));
    }
  }
  return map;
};
const saleReturnedQtyByProduct = (sale, returns = []) => {
  const map = new Map();
  for (const entry of (returns || [])) {
    if (String(entry.saleId || "") !== String(sale?.id || "")) continue;
    for (const line of (entry.lines || [])) {
      const key = String(line.productId || "").trim();
      if (!key) continue;
      map.set(key, Number(map.get(key) || 0) + Number(line.quantity || 0));
    }
  }
  return map;
};
const saleLineRevenueForQty = (sale, line, quantity = 0) => {
  const qty = Math.max(0, Number(quantity || 0));
  const unitPrice = Number(line?.price || 0);
  const grossAmount = Number((unitPrice * qty).toFixed(2));
  const saleSubTotal = Number(sale?.subTotal || 0);
  const billDiscountShare = saleSubTotal > 0
    ? Number((Number(sale?.discountAmount || sale?.discount || 0) * (grossAmount / saleSubTotal)).toFixed(2))
    : 0;
  return Math.max(0, Number((grossAmount - billDiscountShare).toFixed(2)));
};
const effectiveSaleLineState = (sale, line, { returnedByProduct = new Map(), undeliveredByProduct = new Map() } = {}) => {
  const orderedQty = Number(line?.quantity || 0);
  const undeliveredQty = Math.min(orderedQty, Number(undeliveredByProduct.get(String(line?.productId || "")) || 0));
  const soldQty = Math.max(0, orderedQty - undeliveredQty);
  const returnedQty = Math.min(soldQty, Number(returnedByProduct.get(String(line?.productId || "")) || 0));
  const effectiveQty = Math.max(0, soldQty - returnedQty);
  const unitPrice = Number(line?.price || 0);
  const grossEffective = Number((unitPrice * effectiveQty).toFixed(2));
  const billDiscountShare = Number((grossEffective - saleLineRevenueForQty(sale, line, effectiveQty)).toFixed(2));
  const effectiveRevenue = saleLineRevenueForQty(sale, line, effectiveQty);
  return {
    orderedQty,
    undeliveredQty,
    soldQty,
    returnedQty,
    effectiveQty,
    unitPrice,
    billDiscountShare,
    effectiveRevenue
  };
};
const saleNetTotal = (sale) => Number(
  Math.max(
    0,
    Number(
      sale?.netTotalAfterReturns
      ?? (Number(sale?.total || 0) - Number(sale?.returnedAmount || 0) - Number(sale?.undeliveredAmount || 0))
    )
  )
    .toFixed(2)
);
const saleCustomerCreditApplied = (sale) => Number(
  salePayments(sale)
    .filter((payment) => String(payment.method || "").toLowerCase() === "customer_credit")
    .reduce((acc, payment) => acc + Number(payment.amount || 0), 0)
    .toFixed(2)
);
const localDateKey = (value) => {
  const date = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const inDateRange = (iso, from, to) => {
  const day = toColomboDateKey(iso);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
};
const matchesSearch = (term, ...values) => {
  const query = String(term || "").trim().toLowerCase();
  if (!query) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(query));
};

const openSaleReceiptPrint = ({
  sale,
  customers = [],
  products = [],
  fallbackCustomerName = "",
  onPopupBlocked = () => {},
  returnByProduct = new Map(),
  undeliveredByProduct = new Map(),
  returnedAmountOverride = null,
  totalOverride = null
}) => {
  if (typeof window === "undefined" || !sale) return;
  const toMoney = (value) => formatLkrValue(value);
  const saleDate = new Date(sale?.createdAt || Date.now());
  const dateLabel = Number.isNaN(saleDate.getTime())
    ? ""
    : `${String(saleDate.getDate()).padStart(2, "0")}/${String(saleDate.getMonth() + 1).padStart(2, "0")}/${saleDate.getFullYear()}`;

  const pickedCustomer = String(sale?.customerName || fallbackCustomerName || "Walk-in").trim() || "Walk-in";
  const customer = (customers || []).find(
    (row) => String(row?.name || "").trim().toLowerCase() === pickedCustomer.toLowerCase()
  );

    const baseLines = Array.isArray(sale?.lines) ? sale.lines : [];
    const rawBillDiscount = Number(sale?.discountAmount || sale?.discount || 0);
    const returnedAmount = Number(
      returnedAmountOverride !== null && returnedAmountOverride !== undefined
        ? returnedAmountOverride
        : sale?.returnedAmount || 0
    );
    const undeliveredAmount = Number(sale?.undeliveredAmount || 0);
    const hasAdjustedLines = returnedAmount > 0 || undeliveredAmount > 0;
    const lines = baseLines.map((line) => {
      const returned = returnByProduct?.get?.(String(line?.productId || "")) || { qty: 0, amount: 0 };
      const originalQty = Number(line?.quantity || 0);
      const undeliveredQty = Number(undeliveredByProduct?.get?.(String(line?.productId || "")) || 0);
      const soldAfterDelivery = Math.max(0, originalQty - undeliveredQty);
      const qty = Math.max(0, soldAfterDelivery - Number(returned.qty || 0));
      const product = (products || []).find((p) => p.id === line?.productId);
      const billingPrice = Number(line?.basePrice ?? line?.price ?? product?.billingPrice ?? product?.price ?? 0);
      const itemDiscount = lineItemDiscount(line);
      const netUnit = Math.max(0, Number(line?.price ?? (billingPrice - itemDiscount)));
      const sku = line?.sku || product?.sku || "";
      const saleSubTotal = Number(sale?.subTotal || 0);
      const grossRemaining = Number((netUnit * qty).toFixed(2));
      const remainingBillDiscountShare = saleSubTotal > 0
        ? Number((rawBillDiscount * (grossRemaining / saleSubTotal)).toFixed(2))
        : 0;
      const adjustedTotal = Math.max(0, Number((grossRemaining - remainingBillDiscountShare).toFixed(2)));
      const rowTotal = hasAdjustedLines ? adjustedTotal : grossRemaining;
      const bundleSource = product || line;
      const bundleSize = getBundleSize(bundleSource);
      const bundles = bundleSize ? Math.floor(qty / bundleSize) : 0;
      const singles = bundleSize ? qty % bundleSize : qty;
      return {
        description: line?.name || productDisplayName(product) || product?.name || sku,
        sku,
        qty,
        billingPrice,
        itemDiscount,
        billDiscountShare: remainingBillDiscountShare,
        total: rowTotal,
        adjustedTotal,
        grossRemaining,
        undeliveredQty,
        returnedQty: Number(returned.qty || 0),
        returnedAmount: Number(returned.amount || 0),
        originalQty,
        bundles,
        singles,
        bundleSize,
        bundleRule: bundleRuleLabel(bundleSource)
      };
    }).filter((line) => line.qty > 0 || line.total > 0);

  const printedTotal = Number(
      totalOverride !== null && totalOverride !== undefined
        ? totalOverride
        : saleNetTotal(sale)
    );
  const customerCreditApplied = saleCustomerCreditApplied(sale);
  const paymentDisplay = saleDisplayPaymentInfo(sale);
  const lineSubtotal = Number(lines.reduce((acc, line) => acc + Number(line.grossRemaining || 0), 0).toFixed(2));
  const effectiveBillDiscount = hasAdjustedLines
    ? Number(lines.reduce((acc, line) => acc + Number(line.billDiscountShare || 0), 0).toFixed(2))
    : rawBillDiscount;
  const summaryRows = [
    { label: "Line Subtotal", value: lineSubtotal },
    ...(effectiveBillDiscount > 0 ? [{ label: "Bill Discount", value: -effectiveBillDiscount, tone: "deduction" }] : []),
    ...(undeliveredAmount > 0 ? [{ label: "Not Delivered", value: -undeliveredAmount, tone: "deduction" }] : []),
    ...(returnedAmount > 0 ? [{ label: "Returns", value: -returnedAmount, tone: "deduction" }] : []),
    ...(customerCreditApplied > 0 ? [{ label: "Customer Credit", value: -customerCreditApplied, tone: "deduction" }] : [])
  ];

  const rowsHtml = lines
    .map((line, index) => {
      const amountParts = toMoney(line.total).split(".");
      const qtyLabel = line.bundleSize > 0 ? `${line.bundles}B ${line.singles}S` : String(line.singles);
      return `<tr><td>${index + 1}</td><td><strong>${escapeHtml(line.description || line.sku || "-")}</strong>${line.sku ? `<div class="item-code">${escapeHtml(line.sku)}</div>` : ""}${line.undeliveredQty > 0 ? `<div class="return-print-note">Not Delivered ${line.undeliveredQty}</div>` : ""}${line.returnedQty > 0 ? `<div class="return-print-note">Returned ${line.returnedQty}</div>` : ""}</td><td>${escapeHtml(qtyLabel)}</td><td>${toMoney(line.billingPrice)}</td><td>${escapeHtml(amountParts[0] || "0")}</td><td>${escapeHtml(amountParts[1] || "00")}</td></tr>`;
    })
    .join("");
  const minimumPrintRows = 14;
  const blankRowsHtml = Array.from({ length: Math.max(0, minimumPrintRows - lines.length) }, () => `<tr class="blank-row"><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>`).join("");
  const summaryRowsHtml = summaryRows
    .filter((row) => row.label !== "Line Subtotal")
    .map((row) => `<div class="summary-row ${row.tone === "deduction" ? "is-deduction" : ""}"><span>${escapeHtml(row.label)}</span><strong>${row.value < 0 ? "- " : ""}LKR ${toMoney(Math.abs(row.value))}</strong></div>`)
    .join("");
  const bundleGuideText = [...new Set(lines.map((line) => String(line.bundleRule || "").trim()).filter(Boolean))].join(" | ");

  const printWindow = window.open("", "_blank", "width=1000,height=1300");
  if (!printWindow) {
    onPopupBlocked();
    return;
  }

  const receiptHtml = `<!doctype html><html><head><meta charset="utf-8" /><title>Receipt #${escapeHtml(sale.id)}</title><style>
@page { size: A4 portrait; margin: 8mm; } body { margin: 0; background: #fff; font-family: Georgia, "Times New Roman", serif; color: #102033; }
.sheet { width: 100%; max-width: 194mm; margin: 0 auto; padding: 2mm 3mm; }
.header { display: grid; justify-items: center; align-items: center; padding: 2mm 4mm 1.8mm; border-top: 1px solid #c4c4c4; border-bottom: 2px solid #1b68aa; text-align: center; color: #003f82; }
.logo-text { font-family: "Arial Black", Arial, Helvetica, sans-serif; font-size: 42px; line-height: 0.92; font-weight: 900; letter-spacing: 18px; color: #1264aa; white-space: nowrap; margin-left: 18px; }
.brand-kicker { margin-top: 2px; max-width: 150mm; font-size: 11px; line-height: 1.15; font-weight: 800; color: #003f82; text-align: center; }
.meta { margin-top: 5mm; display: grid; grid-template-columns: minmax(0, 1fr) 62mm; gap: 14mm; font-size: 16px; color: #102033; }
.field-line { display: flex; align-items: end; min-height: 24px; margin-bottom: 6px; }
.field-line span:first-child { flex: 0 0 auto; }
.dots { border-bottom: 1px dotted #25364c; min-width: 0; flex: 1 1 auto; display: inline-block; margin-left: 6px; padding: 0 5px 1px; font-family: "Segoe UI", Arial, sans-serif; font-size: 14px; color: #0f2d56; }
table { width: 100%; border-collapse: collapse; margin-top: 4mm; table-layout: fixed; font-family: "Segoe UI", Arial, sans-serif; }
col.no { width: 11%; } col.desc { width: 43%; } col.qty { width: 12%; } col.rate { width: 14%; } col.rs { width: 13%; } col.cts { width: 7%; }
th, td { border: 1px solid #1d4f83; padding: 5px 6px; text-align: left; height: 27px; font-size: 13px; vertical-align: top; }
th { background: #145c9d; color: #fff; font-size: 14px; font-weight: 800; text-align: center; }
td:nth-child(1), td:nth-child(3), td:nth-child(4), td:nth-child(5), td:nth-child(6) { text-align: center; }
.blank-row td { height: 31px; }
.item-code { margin-top: 1px; font-size: 10px; color: #496174; font-weight: 700; }
  .return-print-note { margin-top: 2px; color: #9f1d1d; font-size: 11px; font-weight: 700; line-height: 1.2; }
.footer-grid { margin-top: 6mm; display: grid; grid-template-columns: 1fr 70mm; gap: 10mm; align-items: start; font-family: "Segoe UI", Arial, sans-serif; }
.totals-box { border: 1px solid #1d4f83; min-height: 70px; padding: 7px 9px; font-size: 13px; }
.summary-row, .summary-total, .payment-line { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; }
.summary-total { margin-top: 5px; border-top: 2px solid #1d4f83; font-weight: 900; font-size: 17px; }
.notes { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.45; }
.signatures { margin-top: 16mm; display: grid; grid-template-columns: 1fr 1fr; gap: 30px; text-align: center; font-size: 14px; font-family: "Segoe UI", Arial, sans-serif; }
.sign-line { margin-bottom: 6px; letter-spacing: 2px; } .powered { text-align: center; margin-top: 12mm; font-size: 12px; font-family: "Segoe UI", Arial, sans-serif; color: #455b70; }
  </style></head><body><div class="sheet">
<div class="header"><div class="logo-text">SLS</div><div class="brand-kicker">General merchants &amp; whole sale and retail dealers in rice, oil, dried fish,<br/>prawns, bomba duck, golden enchovy and all kinds of fish products</div></div>
<div class="meta"><div class="field-line"><span>Customer :</span><span class="dots">${escapeHtml(pickedCustomer)}</span></div><div class="field-line"><span>Date :</span><span class="dots">${escapeHtml(dateLabel)}</span></div></div>
<table><colgroup><col class="no"/><col class="desc"/><col class="qty"/><col class="rate"/><col class="rs"/><col class="cts"/></colgroup><thead><tr><th>No</th><th>Description</th><th>Qty</th><th>Rate</th><th>Rs</th><th>Cts</th></tr></thead><tbody>${rowsHtml}${blankRowsHtml}</tbody></table>
${bundleGuideText ? `<div class="bundle-guide-line"><span>Bundle Count</span>${escapeHtml(bundleGuideText)}</div>` : ""}
 <div class="footer-grid"><ul class="notes"><li>Return or exchange only with this receipt</li><li>Credit Payment for all goods shall be made no later than 14 days</li></ul><div class="totals-box"><div class="summary-row"><span>Line Subtotal</span><strong>LKR ${toMoney(lineSubtotal)}</strong></div>${summaryRowsHtml}<div class="summary-total"><span>Total Value</span><strong>LKR ${toMoney(printedTotal)}</strong></div><div class="payment-line"><span>Payment</span><strong>${escapeHtml(paymentDisplay.label)}${paymentDisplay.detail ? ` (${escapeHtml(paymentDisplay.detail)})` : ""}</strong></div></div></div>
<div class="signatures"><div><div class="sign-line">.......................................</div><div>Customer Signature</div><div>Rubber Stamp</div></div><div><div class="sign-line">.......................................</div><div>P.S.R Signature</div></div></div>
<div class="powered">Powered By J&amp;Co.</div></div></body></html>`;

  printWindow.document.open();
  printWindow.document.write(receiptHtml);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => printWindow.print(), 250);
};

const LoginScreen = ({ onLogin, error }) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const handleKeyDown = (e) => { if (e.key === "Enter") onLogin({ username, password }); };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/sls-logo.svg" alt="SLS logo" />
        </div>
        <div className="auth-login-title">
          <h2 className="auth-welcome">Welcome Back</h2>
          <p className="auth-subtitle">Sign in to your account</p>
        </div>
        <div className="auth-fields">
          <label className="auth-field">
            <input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={handleKeyDown} placeholder="Username" autoComplete="username" />
          </label>
          <label className="auth-field">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={handleKeyDown} placeholder="Password" autoComplete="current-password" />
          </label>
        </div>
        {error ? <p className="auth-error">{error}</p> : null}
        <button className="auth-submit" type="button" onClick={() => onLogin({ username, password })}>Sign In</button>
        <div className="auth-bottom-logo">
          <a href="https://www.jnco.tech" target="_blank" rel="noreferrer">
            <img src="/powered.png" alt="Powered by" />
          </a>
        </div>
      </div>
    </div>
  );
};

const Header = ({ dashboard, user, onLogout, managerFullAccess = false }) => {
  const headerUser = user.role === "admin" ? "M.W.M.B CHANDRASEKARA" : (user.name || user.username || "").toUpperCase();
  const roleLabel = user.role === "cashier"
    ? "Cashier Dashboard"
    : user.role === "manager"
      ? "Manager Dashboard"
      : "Admin Dashboard";

  return (
    <header className="topbar">
      <div className="header-card">
        <div className="brand">
          <img className="brand-logo" src="/sls-logo.svg" alt="SLS logo" />
          <div className="brand-copy">
            <h1>SLS</h1>
            <p className="brand-user">{headerUser}</p>
            <p className="brand-role">{roleLabel}</p>
            {user.role === "manager" ? (
              <span className={`header-pill manager-mode-pill ${managerFullAccess ? "manager-mode-pill-full" : "manager-mode-pill-limited"}`}>
                {managerFullAccess ? "Full Access Enabled" : "Limited Access"}
              </span>
            ) : null}
          </div>
        </div>
        <button className="logout-btn" type="button" onClick={onLogout}>LOG OUT</button>
      </div>
      
    </header>
  );
};

const CashierView = ({
  state,
  dashboard,
  search,
  setSearch,
  cashier,
  customerName,
  setCustomerName,
  lorry,
  setLorry,
  paymentType,
  setPaymentType,
  cashReceived,
  setCashReceived,
  creditDueDate,
  setCreditDueDate,
  chequeAmount,
  setChequeAmount,
  chequeNo,
  setChequeNo,
  chequeDate,
  setChequeDate,
  chequeBank,
  setChequeBank,
  discountMode,
  setDiscountMode,
  discountValue,
  setDiscountValue,
  selectedCustomerDiscountLimit,
  selectedCustomerBundleDiscountLimit,
  selectedCustomerAvailableCredit,
  cartDiscountTotal,
  customerCreditDraft,
  setCustomerCreditDraft,
  appliedCustomerCredit,
  totalAfterCustomerCredit,
  lorryLoadMap,
  currentCartQty,
  cart,
  setCart,
  totals,
    message,
    setMessage,
    onSaleDeleted,
    onSuccess,
    onLogout,
    onBillingFocusChange,
    requestConfirm,
    savingCheckout,
    checkout
  }) => {
  const LORRY_CAPACITY = 2880;
  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return state.products;
    return state.products.filter((item) =>
      item.name.toLowerCase().includes(term)
      || item.sku.toLowerCase().includes(term)
      || item.category.toLowerCase().includes(term)
      || String(item.size || "").toLowerCase().includes(term)
      || productDisplayName(item).toLowerCase().includes(term)
    );
  }, [search, state.products]);

  const itemSizeGroups = useMemo(() => {
    const groups = new Map();
    for (const product of filteredProducts) {
      const explicitSize = String(product?.size || "").trim();
      const sizeMl = extractSizeMl(explicitSize || product?.name || "");
      const label = explicitSize || (sizeMl > 0 ? `${sizeMl} ml` : "Other");
      const numericSort = sizeMl > 0 ? sizeMl : Number.POSITIVE_INFINITY;
      if (!groups.has(label)) groups.set(label, { label, sort: numericSort, products: [] });
      groups.get(label).products.push(product);
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.sort !== b.sort) return a.sort - b.sort;
      return String(a.label).localeCompare(String(b.label));
    });
  }, [filteredProducts]);
  const cartQtyByProduct = useMemo(() => {
    const map = new Map();
    for (const line of (cart || [])) {
      map.set(line.productId, (map.get(line.productId) || 0) + Number(line.quantity || 0));
    }
    return map;
  }, [cart]);

  const getCatalogStock = (product) => {
    const currentStock = Number(product?.stock || 0);
    const reserved = Number(cartQtyByProduct.get(product?.id) || 0);
    return Math.max(0, currentStock - reserved);
  };
  const lowStockThreshold = Number(state?.settings?.lowStockThreshold ?? 20);

  const savedCustomers = useMemo(() => {
    return [...(state.customers || [])].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }, [state.customers]);
  const [repCustomerSearch, setRepCustomerSearch] = useState("");
  const filteredRepCustomers = useMemo(() => {
    const term = String(repCustomerSearch || "").trim().toLowerCase();
    if (!term) return savedCustomers;
    return savedCustomers.filter((customer) => String(customer.name || "").toLowerCase().includes(term));
  }, [repCustomerSearch, savedCustomers]);
  const customerOpeningOutstandingMap = useMemo(() => {
    const map = new Map();
    for (const customer of (state.customers || [])) {
      const key = String(customer.name || "").trim();
      if (!key) continue;
      const openingOutstanding = Number(customer.openingOutstanding || 0);
      if (openingOutstanding > 0) {
        map.set(key, openingOutstanding);
      }
    }
    return map;
  }, [state.customers]);
  const customerOutstandingAdjustmentMap = useMemo(() => {
    const map = new Map();
    for (const customer of (state.customers || [])) {
      const key = String(customer.name || "").trim();
      if (!key) continue;
      const adjustment = Number(customer.outstandingAdjustment || 0);
      if (adjustment > 0) {
        map.set(key, Math.max(Number(map.get(key) || 0), adjustment));
      }
    }
    return map;
  }, [state.customers]);
  const customerOutstandingMap = useMemo(() => {
    const map = new Map(customerOpeningOutstandingMap);
    for (const sale of (state.sales || [])) {
      const key = String(sale.customerName || "").trim();
      if (!key || key.toLowerCase() === "walk-in") continue;
      const outstanding = Number(
        sale.outstandingAmount !== undefined
          ? sale.outstandingAmount
          : (sale.paymentType === "credit" ? saleNetTotal(sale) : 0)
      ) || 0;
      if (outstanding > 0) {
        map.set(key, (map.get(key) || 0) + outstanding);
      }
    }
    for (const [key, adjustment] of customerOutstandingAdjustmentMap.entries()) {
      map.set(key, Math.max(0, Number((Number(map.get(key) || 0) - Number(adjustment || 0)).toFixed(2))));
    }
    return map;
  }, [state.sales, customerOpeningOutstandingMap, customerOutstandingAdjustmentMap]);
  const selectedCustomerOutstanding = useMemo(() => {
    const key = String(customerName || "").trim();
    if (!key) return 0;
    return Number(customerOutstandingMap.get(key) || 0);
  }, [customerName, customerOutstandingMap]);
  const repSessionStats = useMemo(() => {
    const rep = String(cashier || "").trim().toLowerCase();
    const today = toColomboDateKey();
    let orders = 0;
    let revenue = 0;
    for (const sale of (state.sales || [])) {
      const saleRep = String(sale.cashier || "").trim().toLowerCase();
      if (!rep || saleRep !== rep) continue;
      if (toColomboDateKey(sale.createdAt) !== today) continue;
      orders += 1;
      revenue += saleNetTotal(sale);
    }
    return { orders, revenue: Number(revenue.toFixed(2)) };
  }, [cashier, state.sales]);
  const [repProductivityDateFrom, setRepProductivityDateFrom] = useState(() => toColomboDateKey());
  const [repProductivityDateTo, setRepProductivityDateTo] = useState(() => toColomboDateKey());
  const [repSalesSearch, setRepSalesSearch] = useState("");
  const [repRecentSalesSearch, setRepRecentSalesSearch] = useState("");
  const [repComparisonSearch, setRepComparisonSearch] = useState("");
  const [repStockSearch, setRepStockSearch] = useState("");

  const damagedQtyByProduct = useMemo(() => {
    const map = new Map();
    for (const ret of (state.returns || [])) {
      for (const line of (ret.lines || [])) {
        if (String(line.condition || "").toLowerCase() !== "damaged") continue;
        map.set(line.productId, (map.get(line.productId) || 0) + Number(line.quantity || 0));
      }
    }
    return map;
  }, [state.returns]);

  const repStockRows = useMemo(() => {
    return (state.products || [])
      .map((product) => {
        const remaining = Number(product.stock || 0);
        const damaged = Number(damagedQtyByProduct.get(product.id) || 0);
        return {
          id: product.id,
          name: productDisplayName(product),
          billingPrice: Number(product?.billingPrice ?? product?.price ?? 0),
          mrp: Number(product?.mrp ?? product?.price ?? 0),
          remaining,
          damaged
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [state.products, damagedQtyByProduct]);
  const filteredRepStockBaseRows = useMemo(() => {
    const term = String(repStockSearch || "").trim().toLowerCase();
    if (!term) return repStockRows;
    return repStockRows.filter((row) => matchesSearch(term, row.name, row.id));
  }, [repStockRows, repStockSearch]);

  const repStockSummary = useMemo(() => {
    let remainingTotal = 0;
    let damagedTotal = 0;
    for (const row of repStockRows) {
      remainingTotal += Number(row.remaining || 0);
      damagedTotal += Number(row.damaged || 0);
    }
    return {
      remainingItems: remainingTotal,
      damagedItems: damagedTotal,
      damagedSkus: repStockRows.filter((row) => row.damaged > 0).length
    };
  }, [repStockRows]);
  const [repStockSort, setRepStockSort] = useState({ key: "name", dir: "asc" });
  const toggleRepStockSort = (key) => {
    setRepStockSort((current) => current.key === key
      ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
      : { key, dir: "asc" });
  };
  const repStockSortMark = (key) => repStockSort.key === key ? (repStockSort.dir === "asc" ? " ▲" : " ▼") : "";
  const sortedRepStockRows = useMemo(
    () => {
      const factor = repStockSort.dir === "asc" ? 1 : -1;
      const getValue = {
        name: (row) => String(row.name || ""),
        billingPrice: (row) => Number(row.billingPrice || 0),
        mrp: (row) => Number(row.mrp || 0),
        remaining: (row) => Number(row.remaining || 0)
      }[repStockSort.key] || ((row) => String(row.name || ""));
      return [...filteredRepStockBaseRows].sort((a, b) => {
        const av = getValue(a);
        const bv = getValue(b);
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
        return String(av || "").localeCompare(String(bv || ""), undefined, { numeric: true, sensitivity: "base" }) * factor;
      });
    },
    [filteredRepStockBaseRows, repStockSort]
  );
  const sortedRepDamagedRows = useMemo(
    () => {
      const factor = repStockSort.dir === "asc" ? 1 : -1;
      const getValue = {
        name: (row) => String(row.name || ""),
        billingPrice: (row) => Number(row.billingPrice || 0),
        mrp: (row) => Number(row.mrp || 0),
        damaged: (row) => Number(row.damaged || 0)
      }[repStockSort.key] || ((row) => String(row.name || ""));
      return [...filteredRepStockBaseRows]
        .filter((row) => row.damaged > 0)
        .sort((a, b) => {
          const av = getValue(a);
          const bv = getValue(b);
          if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
          return String(av || "").localeCompare(String(bv || ""), undefined, { numeric: true, sensitivity: "base" }) * factor;
        });
    },
    [filteredRepStockBaseRows, repStockSort]
  );

  const customerNameOptions = useMemo(() => {
    const names = new Set((state.customers || []).map((item) => String(item.name || "").trim()).filter(Boolean));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [state.customers]);

  const filteredCustomerOptions = useMemo(() => {
    const term = customerName.trim().toLowerCase();
    if (!term) return [];
    return customerNameOptions.filter((name) => name.toLowerCase().includes(term)).slice(0, 8);
  }, [customerName, customerNameOptions]);
  const lorryLoadRows = useMemo(
    () => ORDER_LORRIES.map((name) => ({ name, load: Number(lorryLoadMap?.[name] || 0), isOverflow: !BASE_LORRIES.includes(name) })),
    [lorryLoadMap]
  );
  const selectedSavedCustomer = useMemo(() => {
    const key = String(customerName || "").trim().toLowerCase();
    if (!key) return null;
    const matches = (state.customers || []).filter((item) => String(item.name || "").trim().toLowerCase() === key);
    if (!matches.length) return null;
    return matches.reduce((merged, item) => ({
      ...(merged || {}),
      ...item,
      phone: String(item.phone || "").trim() || String(merged?.phone || "").trim(),
      address: String(item.address || "").trim() || String(merged?.address || "").trim(),
      openingOutstanding: Math.max(Number(merged?.openingOutstanding || 0), Number(item.openingOutstanding || 0)),
      creditLimit: Math.max(Number(merged?.creditLimit || 0), Number(item.creditLimit || 0)),
      discountLimit: Math.max(Number(merged?.discountLimit || 0), Number(item.discountLimit || 0)),
      outstandingAdjustment: Math.max(Number(merged?.outstandingAdjustment || 0), Number(item.outstandingAdjustment || 0)),
      outstandingAdjustmentReason: String(item.outstandingAdjustmentReason || "").trim() || String(merged?.outstandingAdjustmentReason || "").trim()
    }), null);
  }, [customerName, state.customers]);
  const [customerPhoneDraft, setCustomerPhoneDraft] = useState("");
  const [savingCustomerPhone, setSavingCustomerPhone] = useState(false);

  useEffect(() => {
    setCustomerPhoneDraft(String(selectedSavedCustomer?.phone || ""));
  }, [selectedSavedCustomer?.id, selectedSavedCustomer?.phone]);

  const triggerAddHaptic = () => {
    const now = Date.now();
    if (now - lastHapticAtRef.current < 120) return;
    lastHapticAtRef.current = now;
    try {
      if (typeof window === "undefined") return;
      const vibrate = window.navigator?.vibrate;
      if (typeof vibrate !== "function") return;
      const ok = vibrate.call(window.navigator, [18, 12, 22]);
      if (!ok) vibrate.call(window.navigator, 28);
    } catch {}
  };

  const addToCartWithQty = (product, requestedQty) => {
    if (getCatalogStock(product) <= 0) return;
    triggerAddHaptic();
    const requested = Math.floor(Number(requestedQty || 1));
    const requestQty = Number.isFinite(requested) && requested > 0 ? requested : 1;
    setCart((current) => {
      const idx = current.findIndex((line) => line.productId === product.id);
      const alreadyInCart = idx === -1 ? 0 : Number(current[idx].quantity || 0);
      const available = Math.max(0, Number(product.stock || 0) - alreadyInCart);
      if (available <= 0) return current;
      const addQty = Math.min(available, requestQty);
      if (idx === -1) return [...current, {
        productId: product.id,
        name: productDisplayName(product),
        basePrice: productSalePrice(product),
        itemDiscount: 0,
        itemDiscountMode: "amount",
        price: productSalePrice(product),
        quantity: addQty
      }];
      const clone = [...current];
      clone[idx] = { ...clone[idx], quantity: clone[idx].quantity + addQty };
      return clone;
    });
    setCatalogQtyDrafts((current) => ({ ...current, [product.id]: "" }));
  };

  const addToCart = (product) => {
    const requested = Math.floor(Number(catalogQtyDrafts[product.id]));
    if (!Number.isFinite(requested) || requested <= 0) return;
    addToCartWithQty(product, requested);
  };
  const removeFromCartWithQty = (product, requestedQty) => {
    const requested = Math.floor(Number(requestedQty || 1));
    const removeQty = Number.isFinite(requested) && requested > 0 ? requested : 1;
    const currentQty = Math.max(0, Number(cartQtyByProduct.get(product?.id) || 0));
    if (currentQty <= 0) return;
    triggerAddHaptic();
    updateQty(product.id, Math.max(0, currentQty - removeQty));
  };

  const updateQty = (productId, quantity) => {
    if (quantity === "") return;
    const parsed = Number(quantity);
    if (!Number.isFinite(parsed)) return;
    let nextQty = Math.floor(parsed);
    if (nextQty <= 0) {
      setCart((current) => current.filter((line) => line.productId !== productId));
      return;
    }
    const product = state?.products?.find((p) => p.id === productId);
    if (product) {
      const stockLimit = Math.max(0, Number(product.stock || 0));
      if (nextQty > stockLimit) nextQty = stockLimit;
    }
    setCart((current) => current.map((line) => (line.productId === productId ? { ...line, quantity: nextQty } : line)));
  };
  const updateQtyByBundle = (line, direction) => {
    const bundleSize = getBundleSize(line);
    if (!(bundleSize > 0)) return;
    const currentQty = Math.max(0, Number(line?.quantity || 0));
    const nextQty = direction === "down"
      ? Math.max(0, currentQty - bundleSize)
      : currentQty + bundleSize;
    updateQty(line.productId, nextQty);
  };
  const updateItemDiscount = (productId, value) => {
    const parsed = Number(value || 0);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setCart((current) => current.map((line) => {
      if (line.productId !== productId) return line;
      const base = lineBasePrice(line);
      const mode = String(line.itemDiscountMode || "amount");
      if (mode === "percent") return { ...line, itemDiscount: Math.min(parsed, 100) };
      return { ...line, itemDiscount: Math.min(parsed, base) };
    }));
  };
  const updateItemDiscountMode = (productId, mode) => {
    setCart((current) => current.map((line) => {
      if (line.productId !== productId) return line;
      const nextMode = mode === "percent" ? "percent" : "amount";
      const currentValue = Number(line.itemDiscount || 0);
      const clamped = nextMode === "percent"
        ? Math.min(Math.max(0, currentValue), 100)
        : Math.min(Math.max(0, currentValue), lineBasePrice(line));
      return { ...line, itemDiscountMode: nextMode, itemDiscount: clamped };
    }));
  };
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [showCartPopup, setShowCartPopup] = useState(false);
  const [showItemSizePicker, setShowItemSizePicker] = useState(false);
  const [activeItemSize, setActiveItemSize] = useState("");
  const [sizeProductSearch, setSizeProductSearch] = useState("");
  const [expandedSizeProductId, setExpandedSizeProductId] = useState("");
  const [customerDraft, setCustomerDraft] = useState({ name: "", phone: "", address: "" });
  const [customerDraftError, setCustomerDraftError] = useState("");
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [showCustomerSuggestions, setShowCustomerSuggestions] = useState(false);
  const [catalogQtyDrafts, setCatalogQtyDrafts] = useState({});
  const [cashierPage, setCashierPage] = useState("billing");
  const [returnSaleId, setReturnSaleId] = useState("");
  const [returnCustomerName, setReturnCustomerName] = useState("");
  const [showReturnCustomerSuggestions, setShowReturnCustomerSuggestions] = useState(false);
  const [returnLinesDraft, setReturnLinesDraft] = useState({});
  const [returnError, setReturnError] = useState("");
  const [savingReturn, setSavingReturn] = useState(false);
  const lastHapticAtRef = useRef(0);
  const [mobileCashierNavOpen, setMobileCashierNavOpen] = useState(false);
  const [repBillingStep, setRepBillingStep] = useState("customer");
  const [showPostSaleHomeButton, setShowPostSaleHomeButton] = useState(false);

  useEffect(() => {
    setMobileCashierNavOpen(false);
    scrollViewportToTop();
  }, [cashierPage]);

  useEffect(() => {
    if (cashierPage === "billing") scrollViewportToTop();
  }, [cashierPage, repBillingStep]);

  useEffect(() => {
    if (repBillingStep !== "items") {
      setShowItemSizePicker(false);
      setSizeProductSearch("");
      setExpandedSizeProductId("");
    }
  }, [repBillingStep]);
  useEffect(() => {
    if (!showItemSizePicker) setExpandedSizeProductId("");
  }, [showItemSizePicker]);
  useEffect(() => {
    if ((cart || []).length > 0) setShowPostSaleHomeButton(false);
  }, [cart]);

  useEffect(() => {
    onBillingFocusChange?.(cashierPage === "billing");
    return () => onBillingFocusChange?.(false);
  }, [cashierPage, onBillingFocusChange]);

  const returnSale = useMemo(
    () => state.sales.find((sale) => String(sale.id) === String(returnSaleId).trim()) || null,
    [state.sales, returnSaleId]
  );
  const activeSizeProducts = useMemo(() => {
    if (!activeItemSize) return [];
    const group = itemSizeGroups.find((row) => row.label === activeItemSize);
    if (!group) return [];
    const term = String(sizeProductSearch || "").trim().toLowerCase();
    if (!term) return group.products;
    return group.products.filter((item) =>
      productDisplayName(item).toLowerCase().includes(term)
      || String(item.sku || "").toLowerCase().includes(term)
      || String(item.category || "").toLowerCase().includes(term)
    );
  }, [activeItemSize, itemSizeGroups, sizeProductSearch]);

  const returnCustomerOptions = useMemo(() => {
    const rep = String(cashier || "").trim().toLowerCase();
    const names = new Set(
      (state.sales || [])
        .filter((sale) => String(sale.cashier || "").trim().toLowerCase() === rep)
        .map((sale) => String(sale.customerName || "").trim())
        .filter(Boolean)
    );
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [state.sales, cashier]);

  const filteredReturnCustomerOptions = useMemo(() => {
    const term = String(returnCustomerName || "").trim().toLowerCase();
    if (!term) return [];
    return returnCustomerOptions.filter((name) => name.toLowerCase().includes(term)).slice(0, 8);
  }, [returnCustomerName, returnCustomerOptions]);

  const returnSalesForCustomer = useMemo(() => {
    const rep = String(cashier || "").trim().toLowerCase();
    const selected = String(returnCustomerName || "").trim().toLowerCase();
    if (!selected) return [];
    return (state.sales || [])
      .filter((sale) =>
        String(sale.cashier || "").trim().toLowerCase() === rep
        && String(sale.customerName || "").trim().toLowerCase() === selected
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [state.sales, cashier, returnCustomerName]);

  const returnedQtyByProduct = useMemo(() => {
    const map = new Map();
    const saleId = String(returnSaleId).trim();
    if (!saleId) return map;
    for (const ret of (state.returns || [])) {
      if (String(ret.saleId) !== saleId) continue;
      for (const line of (ret.lines || [])) {
        map.set(line.productId, (map.get(line.productId) || 0) + Number(line.quantity || 0));
      }
    }
    return map;
  }, [state.returns, returnSaleId]);
  const returnDraftSummary = useMemo(() => {
    if (!returnSale) return { qty: 0, amount: 0, goodQty: 0, damagedQty: 0 };
    return (returnSale.lines || []).reduce((acc, line) => {
      const draft = returnLinesDraft[line.productId] || {};
      const qty = Number(draft.quantity || 0);
      if (!Number.isFinite(qty) || qty <= 0) return acc;
      const preview = returnLinePreview(returnSale, line, qty);
      acc.qty += qty;
      acc.amount += Number(preview.returnAmount || 0);
      if (String(draft.condition || "good").toLowerCase() === "good") acc.goodQty += qty;
      else acc.damagedQty += qty;
      return acc;
    }, { qty: 0, amount: 0, goodQty: 0, damagedQty: 0 });
  }, [returnLinesDraft, returnSale]);

  const quickAddCustomer = () => {
    setCustomerDraft({ name: "", phone: "", address: "" });
    setCustomerDraftError("");
    setShowAddCustomer(true);
  };

  const saveQuickCustomer = async () => {
    const name = customerDraft.name.trim();
    const phone = customerDraft.phone.trim();
    const address = customerDraft.address.trim();
    if (!name || !phone || !address) {
      setCustomerDraftError("Customer name, mobile, and address are required.");
      return;
    }
    try {
      setSavingCustomer(true);
      await createCustomer({ name, phone, address });
      setCustomerName(name);
      setShowAddCustomer(false);
    } catch (error) {
      setCustomerDraftError(error.message);
    } finally {
      setSavingCustomer(false);
    }
  };

  const onReturnDraftChange = (productId, patch) => {
    setReturnLinesDraft((current) => ({
      ...current,
      [productId]: { quantity: current[productId]?.quantity || "", condition: current[productId]?.condition || "good", ...patch }
    }));
  };

  const submitReturnFromSale = async () => {
    try {
      const saleId = String(returnSaleId || "").trim();
      if (!saleId) {
        setReturnError("Enter Sale ID.");
        return;
      }
      if (!returnSale) {
        setReturnError("Sale not found.");
        return;
      }
      if (String(returnSale.cashier || "").trim().toLowerCase() !== String(cashier || "").trim().toLowerCase()) {
        setReturnError(`Sale belongs to ${returnSale.cashier || "another rep"}. You can return only your own sales.`);
        return;
      }
      const lines = (returnSale.lines || [])
        .map((line) => {
          const draft = returnLinesDraft[line.productId] || {};
          const qty = Number(draft.quantity || 0);
          return {
            productId: line.productId,
            quantity: qty,
            condition: draft.condition || "good"
          };
        })
        .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
      if (!lines.length) {
        setReturnError("Enter at least one return quantity.");
        return;
      }
      setSavingReturn(true);
      setReturnError("");
      await submitReturn({ saleId, lines });
      setReturnLinesDraft({});
      setReturnSaleId("");
      onSuccess?.("Return Submitted.");
    } catch (error) {
      setReturnError(error.message);
    } finally {
      setSavingReturn(false);
    }
  };

  const repSales = useMemo(() => {
    const rep = String(cashier || "").trim().toLowerCase();
    return (state.sales || [])
      .filter((sale) => String(sale.cashier || "").trim().toLowerCase() === rep)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [cashier, state.sales]);
  const repProductivitySales = useMemo(
    () => repSales.filter((sale) => inDateRange(sale.createdAt, repProductivityDateFrom, repProductivityDateTo)),
    [repSales, repProductivityDateFrom, repProductivityDateTo]
  );
  const repProductivityStats = useMemo(() => {
    const customerSet = new Set();
    let value = 0;
    let qty = 0;
    let bundles = 0;
    let singles = 0;
    for (const sale of repProductivitySales) {
      customerSet.add(String(sale.customerName || "Walk-in").trim() || "Walk-in");
      value += saleNetTotal(sale);
      const returnedByProduct = saleReturnedQtyByProduct(sale, state.returns || []);
      const undeliveredByProduct = saleUndeliveredQtyByProduct(sale);
      for (const line of (sale.lines || [])) {
        const lineState = effectiveSaleLineState(sale, line, { returnedByProduct, undeliveredByProduct });
        qty += lineState.effectiveQty;
        const breakdown = getBundleBreakdown({ ...line, qty: lineState.effectiveQty });
        bundles += Number(breakdown.bundles || 0);
        singles += Number(breakdown.singles || 0);
      }
    }
    return {
      orders: repProductivitySales.length,
      value: Number(value.toFixed(2)),
      qty,
      bundles,
      singles,
      customers: customerSet.size
    };
  }, [repProductivitySales, state.returns]);
  const repCompareRows = useMemo(() => {
    const map = new Map();
    for (const sale of (state.sales || [])) {
      const rep = String(sale.cashier || "Unknown").trim() || "Unknown";
      const row = map.get(rep) || { rep, bills: 0, revenue: 0 };
      row.bills += 1;
      row.revenue += saleNetTotal(sale);
      map.set(rep, row);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [state.sales]);
  const filteredRepSales = useMemo(
    () =>
      repSales.filter((sale) =>
        matchesSearch(repSalesSearch, sale.id, sale.customerName, sale.lorry, sale.paymentType, sale.createdAt)
      ),
    [repSales, repSalesSearch]
  );
  const filteredRecentSales = useMemo(
    () =>
      (state.sales || [])
        .slice(0, 20)
        .filter((sale) =>
          matchesSearch(
            repRecentSalesSearch,
            sale.id,
            sale.customerName,
            sale.cashier,
            sale.lorry,
            sale.paymentType,
            sale.createdAt
          )
        ),
    [state.sales, repRecentSalesSearch]
  );
  const filteredRepCompareRows = useMemo(
    () => repCompareRows.filter((row) => matchesSearch(repComparisonSearch, row.rep)),
    [repCompareRows, repComparisonSearch]
  );
  const [editingSaleId, setEditingSaleId] = useState("");
  const [saleEditLines, setSaleEditLines] = useState([]);
  const [saleEditPaymentType, setSaleEditPaymentType] = useState(PAYMENT_TYPES[0]);
  const [saleEditBillDiscount, setSaleEditBillDiscount] = useState("");
  const [saleEditError, setSaleEditError] = useState("");
  const [savingSaleEdit, setSavingSaleEdit] = useState(false);
  const saleEditSubTotal = useMemo(
    () => Number(saleEditLines.reduce((acc, line) => acc + (lineFinalPrice(line) * Number(line.quantity || 0)), 0).toFixed(2)),
    [saleEditLines]
  );
  const closeSaleEdit = () => {
    setEditingSaleId("");
    setSaleEditPaymentType(PAYMENT_TYPES[0]);
    setSaleEditBillDiscount("");
    setSaleEditLines([]);
    setSaleEditError("");
  };

  const openSaleEdit = (sale) => {
    const hasDeliveryProcessing = Boolean(sale?.deliveryConfirmedAt) || Boolean((sale?.deliveryAdjustments || []).length);
    const hasReturns = (state.returns || []).some((ret) => String(ret.saleId) === String(sale?.id));
    if (hasDeliveryProcessing) {
      setNotice("This bill cannot be edited after delivery processing has started.");
      return;
    }
    if (hasReturns) {
      setNotice("This bill cannot be edited after returns have been submitted.");
      return;
    }
    setEditingSaleId(sale.id);
    setSaleEditPaymentType(String(sale.paymentType || PAYMENT_TYPES[0]));
    setSaleEditBillDiscount(String(Number(sale.discountAmount ?? sale.discount ?? 0) || 0));
    setSaleEditLines((sale.lines || []).map((line) => ({
      productId: line.productId,
      name: line.name,
      quantity: Number(line.quantity || 0),
      basePrice: Number(line.basePrice ?? line.price ?? 0),
      itemDiscount: editableLineDiscountValue(line),
      itemDiscountMode: String(line.itemDiscountMode || "amount")
    })));
    setSaleEditError("");
  };

  const saveSaleEdit = async () => {
    try {
      const lines = saleEditLines
        .map((line) => ({
          ...line,
          quantity: Number(line.quantity || 0),
          itemDiscount: Number(line.itemDiscount || 0),
          itemDiscountMode: String(line.itemDiscountMode || "amount"),
          price: lineFinalPrice(line)
        }))
        .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
        if (!editingSaleId || !lines.length) {
          setSaleEditError("Keep at least one item in bill.");
          return;
        }
        const billDiscount = Math.max(0, Number(saleEditBillDiscount || 0) || 0);
        if (billDiscount > saleEditSubTotal) {
          setSaleEditError(`Total bill discount cannot exceed subtotal (${currency(saleEditSubTotal)}).`);
          return;
        }
        const saleBeingEdited = (state.sales || []).find((sale) => String(sale.id) === String(editingSaleId));
        const discountLimit = (state.customers || [])
          .filter((item) => String(item.name || "").trim().toLowerCase() === String(saleBeingEdited?.customerName || "").trim().toLowerCase())
          .reduce((max, item) => Math.max(max, Number(item.discountLimit || 0)), 0);
        const bundleDiscountLimit = (state.customers || [])
          .filter((item) => String(item.name || "").trim().toLowerCase() === String(saleBeingEdited?.customerName || "").trim().toLowerCase())
          .reduce((max, item) => Math.max(max, Number(item.bundleDiscountLimit || 0)), 0);
        const totalDiscount = totalDiscountApplied({ lines, billDiscount });
        if (discountLimit > 0 && totalDiscount > discountLimit) {
          setSaleEditError(`Customer discount limit is ${currency(discountLimit)}. Current discount is ${currency(totalDiscount)}.`);
          return;
        }
        const bundleDiscountViolation = findBundleDiscountViolation({ lines, bundleDiscountLimit });
        if (bundleDiscountViolation) {
          setSaleEditError(`${bundleDiscountViolation.lineName} exceeds bundle discount limit. Allowed: ${currency(bundleDiscountViolation.allowedBundleDiscount)} for ${bundleDiscountViolation.fullBundles} bundle(s).`);
          return;
        }
        setSavingSaleEdit(true);
        setSaleEditError("");
      await patchSale(editingSaleId, { lines, paymentType: saleEditPaymentType, discount: billDiscount });
        closeSaleEdit();
      } catch (error) {
        setSaleEditError(error.message);
    } finally {
      setSavingSaleEdit(false);
    }
  };

  const saveBillingCustomerPhone = async () => {
    if (!selectedSavedCustomer) return;
    try {
      setSavingCustomerPhone(true);
      await updateCustomer(selectedSavedCustomer.id, {
        name: selectedSavedCustomer.name || customerName.trim(),
        phone: customerPhoneDraft.trim(),
        address: selectedSavedCustomer.address || ""
      });
      setMessage("Customer phone updated.");
    } catch (error) {
      setMessage(error.message || "Unable to update customer phone.");
    } finally {
      setSavingCustomerPhone(false);
    }
  };
  const repBillingSteps = [
    { key: "customer", label: "Customer", icon: "👤" },
    { key: "items", label: "Items", icon: "📦" },
    { key: "cart", label: "Cart", icon: "🛒" },
    { key: "checkout", label: "Complete", icon: "✅" }
  ];
  const repBillingStepIndex = Math.max(0, repBillingSteps.findIndex((step) => step.key === repBillingStep));
  const selectedBundleViolation = findBundleDiscountViolation({ lines: cart, bundleDiscountLimit: selectedCustomerBundleDiscountLimit });

  const deleteRepSale = async (sale) => {
    try {
      const saleCashier = String(sale?.cashier || "").trim().toLowerCase();
      const actingRep = String(cashier || "").trim().toLowerCase();
      const hasDeliveryProcessing = Boolean(sale?.deliveryConfirmedAt) || Boolean((sale?.deliveryAdjustments || []).length);
      if (!sale || !saleCashier || saleCashier !== actingRep) {
        setNotice("You can delete only your own bills.");
        return;
      }
      if (hasDeliveryProcessing) {
        setNotice("This bill cannot be deleted after delivery processing has started.");
        return;
      }
      const ok = await requestConfirm({
        title: "Delete Sale",
        message: `Are you sure want to delete sale #${sale.id}? All items on this bill will be restocked.`,
        confirmLabel: "Delete",
        tone: "danger"
      });
      if (!ok) return;
      await deleteSale(sale.id);
      onSaleDeleted?.(sale.id);
        if (String(editingSaleId || "") === String(sale.id)) {
          setEditingSaleId("");
          setSaleEditPaymentType(PAYMENT_TYPES[0]);
          setSaleEditLines([]);
          setSaleEditError("");
        }
      setNotice(`Sale #${sale.id} deleted.`);
    } catch (error) {
      setNotice(error.message);
    }
  };
  const billingFocusMode = cashierPage === "billing";

  return (
    <div className={cashierPage === "billing" ? "rep-redesign-scope" : ""}>
      {message && !/(error|invalid|required|cannot|unable|failed|not found|select|enter|type|exceeds)/i.test(String(message)) ? <p className="notice">{message}</p> : null}
      {!billingFocusMode ? (
        <button
          type="button"
          className={`cashier-mobile-nav-toggle menu-toggle-btn ${mobileCashierNavOpen ? "open" : ""}`}
          onClick={() => setMobileCashierNavOpen((current) => !current)}
          aria-expanded={mobileCashierNavOpen}
          aria-controls="cashier-sidebar-nav"
          aria-label={mobileCashierNavOpen ? "Close menu" : "Open menu"}
        >
          <span className="menu-toggle-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="menu-toggle-label">{mobileCashierNavOpen ? "Close" : "Menu"}</span>
        </button>
      ) : null}
      {mobileCashierNavOpen ? (
        <button
          type="button"
          className="cashier-mobile-nav-backdrop"
          onClick={() => setMobileCashierNavOpen(false)}
          aria-label="Close menu"
        />
      ) : null}
      <aside id="cashier-sidebar-nav" className={`cashier-mobile-sidebar ${mobileCashierNavOpen ? "open" : ""} ${billingFocusMode ? "billing-focus-mode" : ""}`}>
        <button type="button" className={`cashier-nav-billing ${cashierPage === "billing" ? "active" : ""}`} onClick={() => setCashierPage("billing")}><span className="nav-emoji" aria-hidden="true">📝</span>Billing</button>
        <button type="button" className={`cashier-nav-returns ${cashierPage === "returns" ? "active" : ""}`} onClick={() => setCashierPage("returns")}><span className="nav-emoji" aria-hidden="true">↩️</span>Returns</button>
        <button type="button" className={`cashier-nav-sales ${cashierPage === "sales" ? "active" : ""}`} onClick={() => setCashierPage("sales")}><span className="nav-emoji" aria-hidden="true">📊</span>Sales</button>
        <button type="button" className={`cashier-nav-stock ${cashierPage === "stock" ? "active" : ""}`} onClick={() => setCashierPage("stock")}><span className="nav-emoji" aria-hidden="true">📦</span>Stock</button>
        <button type="button" className={`cashier-nav-customers ${cashierPage === "customers" ? "active" : ""}`} onClick={() => setCashierPage("customers")}><span className="nav-emoji" aria-hidden="true">👥</span>Customers</button>
        <button type="button" className="cashier-sidebar-logout" onClick={onLogout}><span className="nav-emoji" aria-hidden="true">🚪</span>Log Out</button>
        <div className="side-menu-footer">
          <a href="https://www.jnco.tech" target="_blank" rel="noreferrer">
            <img src="/powered.png" alt="Powered by" />
          </a>
        </div>
      </aside>
      <div className={`cashier-tabs ${billingFocusMode ? "billing-focus-mode" : ""}`}>
        <button type="button" className={`cashier-nav-billing ${cashierPage === "billing" ? "active" : ""}`} onClick={() => setCashierPage("billing")}><span className="nav-emoji" aria-hidden="true">📝</span>Billing</button>
        <button type="button" className={`cashier-nav-returns ${cashierPage === "returns" ? "active" : ""}`} onClick={() => setCashierPage("returns")}><span className="nav-emoji" aria-hidden="true">↩️</span>Returns</button>
        <button type="button" className={`cashier-nav-sales ${cashierPage === "sales" ? "active" : ""}`} onClick={() => setCashierPage("sales")}><span className="nav-emoji" aria-hidden="true">📊</span>Sales</button>
        <button type="button" className={`cashier-nav-stock ${cashierPage === "stock" ? "active" : ""}`} onClick={() => setCashierPage("stock")}><span className="nav-emoji" aria-hidden="true">📦</span>Stock</button>
        <button type="button" className={`cashier-nav-customers ${cashierPage === "customers" ? "active" : ""}`} onClick={() => setCashierPage("customers")}><span className="nav-emoji" aria-hidden="true">👥</span>Customers</button>
      </div>

      {cashierPage === "billing" ? (
        <main className="grid rep-billing-wizard rep-ui-2">
          <section className="panel rep-wizard-shell">
            <div className="rep-wizard-top-actions-row">
              <button
                type="button"
                className={`cashier-mobile-nav-toggle menu-toggle-btn billing-focus-mode in-card ${mobileCashierNavOpen ? "open" : ""}`}
                onClick={() => setMobileCashierNavOpen((current) => !current)}
                aria-expanded={mobileCashierNavOpen}
                aria-controls="cashier-sidebar-nav"
                aria-label={mobileCashierNavOpen ? "Close menu" : "Open menu"}
              >
                <span className="menu-toggle-icon" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="menu-toggle-label">{mobileCashierNavOpen ? "Close" : "Menu"}</span>
              </button>
            </div>
            <div className="rep-wizard-head">
              <div>
                <p className="rep-wizard-eyebrow">Rep Billing</p>
                <h2>{repBillingSteps[repBillingStepIndex]?.label || "Billing"}</h2>
                <p className="form-hint">One focused step at a time for easier mobile billing.</p>
              </div>
              <div className="rep-wizard-meta">
                <span>{cart.length} item(s)</span>
                <strong>{currency(totalAfterCustomerCredit)}</strong>
              </div>
            </div>

            <div className="rep-wizard-progress">
              {repBillingSteps.map((step, index) => (
                <button
                  key={step.key}
                  type="button"
                  className={`rep-wizard-step ${repBillingStep === step.key ? "active" : ""} ${index < repBillingStepIndex ? "done" : ""}`}
                  onClick={() => {
                    if (step.key === "items" && !customerName.trim()) return;
                    if (step.key === "cart" && !cart.length) return;
                    if (step.key === "checkout" && !cart.length) return;
                    setRepBillingStep(step.key);
                  }}
                >
                  <span>{step.icon || (index + 1)}</span>
                  <strong>{step.label}</strong>
                </button>
              ))}
            </div>

            <div className="rep-wizard-body">
              {repBillingStep === "customer" ? (
                <section className="rep-step-screen rep-step-customer">
                  <div className="rep-step-card rep-step-card-primary">
                    <h3>Select Customer</h3>
                    <p className="form-hint">Open a full-screen picker to search and select the customer.</p>
                    <button type="button" className="rep-picker-launch" onClick={() => setShowCustomerPicker(true)}>
                      <span>{customerName.trim() || "Select Customer"}</span>
                      <strong>Open</strong>
                    </button>
                    <div className="rep-step-actions-inline">
                      <button type="button" className="ghost" onClick={quickAddCustomer}>Add New Customer</button>
                    </div>
                    {customerName.trim() ? (
                      <div className="rep-customer-focus-card rep-customer-focus-inline">
                        <strong>{customerName}</strong>
                        <p>Outstanding: {currency(selectedCustomerOutstanding)}</p>
                        {selectedCustomerDiscountLimit > 0 ? <p>Discount Limit: {currency(selectedCustomerDiscountLimit)}</p> : null}
                        {selectedCustomerBundleDiscountLimit > 0 ? <p>Bundle Limit: {currency(selectedCustomerBundleDiscountLimit)} per bundle</p> : null}
                        {selectedSavedCustomer?.phone ? <p>Phone: {selectedSavedCustomer.phone}</p> : null}
                      </div>
                    ) : (
                      <p className="form-hint">No customer selected yet.</p>
                    )}
                  </div>
                </section>
              ) : null}

              {repBillingStep === "items" ? (
                <section className="rep-step-screen rep-step-items">
                  <div className="rep-step-card rep-step-card-primary">
                    <div className="rep-size-layout-head">
                      <h3>SELECT ITEMS</h3>
                      <div className="rep-step-chip">{currentCartQty} units in cart</div>
                    </div>
                    <input
                      className="search-icon-input rep-step-input rep-size-search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search size / product / sku"
                    />
                    <div className="rep-size-grid">
                      {itemSizeGroups.length ? itemSizeGroups.map((group) => (
                        <button
                          key={group.label}
                          type="button"
                          className="rep-size-tile"
                          onClick={() => {
                            setActiveItemSize(group.label);
                            setSizeProductSearch("");
                            setShowItemSizePicker(true);
                          }}
                        >
                          <strong>{group.label}</strong>
                          <span>Available size</span>
                        </button>
                      )) : (
                        <p className="form-hint">No matching sizes found.</p>
                      )}
                    </div>
                  </div>
                </section>
              ) : null}

              {repBillingStep === "cart" ? (
                <div className="modern-cart-wrapper">
                  <header className="mc-header">
                    <button className="mc-btn-back" onClick={() => setRepBillingStep("items")} aria-label="Back">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                    </button>
                    <h2>SHOPPING CART</h2>
                    {showPostSaleHomeButton && !cart.length ? (
                      <button
                        className="mc-btn-home"
                        type="button"
                        onClick={() => {
                          setRepBillingStep("customer");
                          setShowPostSaleHomeButton(false);
                        }}
                        aria-label="Go to customer step"
                      >
                        Home
                      </button>
                    ) : (
                      <button className="mc-btn-dots" onClick={() => setShowCartPopup(true)} aria-label="Edit Quantities">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>
                      </button>
                    )}
                  </header>

                  <div className="mc-items-list">
                    {cart.map((line) => (
                      <article className="mc-item-card" key={`mc-${line.productId}`}>
                        <div className="mc-item-img">
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                        </div>
                        <div className="mc-item-content">
                          <div className="mc-item-row1">
                            <strong className="mc-item-name">{line.name}</strong>
                            <span className="mc-qty-text">×{line.quantity}</span>
                          </div>
                          <div className="mc-item-row2">
                            <span className="mc-price-pill">{currency(lineFinalPrice(line))}</span>
                            <span className="mc-base-price">{currency(lineBasePrice(line))} each</span>
                          </div>
                        </div>
                        <div className="mc-item-disc-row" onClick={(e) => e.stopPropagation()}>
                          <select
                            className="mc-disc-mode"
                            value={line.itemDiscountMode || "amount"}
                            onChange={(e) => updateItemDiscountMode(line.productId, e.target.value)}
                          >
                            <option value="amount">Rs.</option>
                            <option value="percent">%</option>
                          </select>
                          <input
                            className="mc-disc-input"
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.itemDiscount ?? 0}
                            onChange={(e) => updateItemDiscount(line.productId, e.target.value)}
                            placeholder="Item discount"
                          />
                          {lineItemDiscount(line) > 0 && (
                            <span className="mc-disc-badge">-{currency(lineItemDiscount(line))}</span>
                          )}
                        </div>
                      </article>
                    ))}
                    {cart.length === 0 ? <p className="form-hint" style={{textAlign: 'center', marginTop: '2rem'}}>Cart is empty.</p> : null}
                  </div>

                  {cart.length > 0 && (
                    <div className="mc-order-summary">
                      <div className="mc-summary-head">
                        <h3>ORDER SUMMARY</h3>
                        <span className="mc-summary-date">{new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                      </div>

                      <div className="mc-summary-data">
                        <div className="mc-data-row"><span>Sub Total</span><strong>{currency(totals.subTotal)}</strong></div>
                        <div className="mc-data-row"><span>Item Discounts</span><strong>-{currency(cartDiscountTotal)}</strong></div>

                        <div className="mc-disc-bill-row">
                          <label className="mc-disc-label">Bill Discount</label>
                          <div className="mc-disc-bill-inputs">
                            <select value={discountMode} onChange={(e) => setDiscountMode(e.target.value)}>
                              <option value="amount">Rs.</option>
                              <option value="percent">%</option>
                            </select>
                            <input type="number" min="0" step="0.01" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} placeholder="0" />
                          </div>
                          {totals.discountAmount > 0 && <span className="mc-data-row"><span>Applied</span><strong>-{currency(totals.discountAmount)}</strong></span>}
                        </div>

                        <div className="mc-summary-divider"></div>
                        <div className="mc-data-row mc-data-total"><span>Total</span><strong>{currency(totals.total)}</strong></div>
                      </div>

                      {/* ── REVIEW SECTION ── */}
                      <div className="mc-review-section">
                        <h4 className="mc-review-title">Review &amp; Confirm</h4>
                        <div className="mc-review-grid">
                          <article><span>Customer</span><strong>{customerName || "—"}</strong></article>
                          <article><span>Items</span><strong>{cart.length} ({currentCartQty} units)</strong></article>
                        </div>
                        {customerName.trim() && selectedCustomerOutstanding > 0 ? (
                          <p className="mc-review-warn">Outstanding: {currency(selectedCustomerOutstanding)}</p>
                        ) : null}
                        {selectedBundleViolation ? (
                          <p className="mc-review-warn">{selectedBundleViolation.lineName} exceeds bundle discount limit.</p>
                        ) : null}
                        {customerName.trim() && selectedCustomerAvailableCredit > 0 ? (
                          <div className="mc-review-credit">
                            <label>Apply Credit (avail. {currency(selectedCustomerAvailableCredit)})</label>
                            <div className="mc-disc-bill-inputs">
                              <input type="number" min="0" step="0.01" value={customerCreditDraft} onChange={(e) => setCustomerCreditDraft(e.target.value)} placeholder="Credit amount" />
                              <button type="button" className="ghost" onClick={() => setCustomerCreditDraft(String(selectedCustomerAvailableCredit))}>Max</button>
                            </div>
                            {appliedCustomerCredit > 0 ? <p className="mc-review-hint">Payable: {currency(totalAfterCustomerCredit)}</p> : null}
                          </div>
                        ) : null}
                        <label className="mc-review-label">Delivery Route</label>
                        <select className="mc-review-select" value={lorry} onChange={(e) => setLorry(e.target.value)}>
                          <option value="">Select delivery lorry</option>
                          {lorryLoadRows.map((row) => {
                            const remaining = Math.max(0, LORRY_CAPACITY - row.load);
                            const full = !row.isOverflow && remaining <= 0;
                            return (
                              <option key={row.name} value={row.name} disabled={full}>
                                {row.isOverflow ? `${row.name} - Overflow` : (full ? `${row.name} - Full` : `${row.name} - ${remaining} left`)}
                              </option>
                            );
                          })}
                        </select>
                        <label className="mc-review-label">Payment Type</label>
                        <select className="mc-review-select" value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
                          {PAYMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                        </select>
                      </div>
                    </div>
                  )}

                  {cart.length > 0 && (
                    <div className="mc-footer-bar">
                      <div className="mc-footer-total">
                        <span>Total Checkout</span>
                        <strong>{currency(appliedCustomerCredit > 0 ? totalAfterCustomerCredit : totals.total)}</strong>
                      </div>
                      <button className="mc-checkout-button" onClick={checkout} disabled={savingCheckout}>
                        {savingCheckout ? "Processing..." : "Checkout"}
                      </button>
                    </div>
                  )}
                </div>
              ) : null}


              {repBillingStep === "checkout" ? (
                <section className="rep-step-screen rep-step-checkout">
                  <div className="rep-step-card rep-step-card-primary">
                    <h3>Review & Complete</h3>
                    <div className="rep-checkout-review-grid">
                      <article>
                        <span>Customer</span>
                        <strong>{customerName || "-"}</strong>
                      </article>
                      <article>
                        <span>Items</span>
                        <strong>{cart.length}</strong>
                      </article>
                      <article>
                        <span>Units</span>
                        <strong>{currentCartQty}</strong>
                      </article>
                      <article>
                        <span>Payable</span>
                        <strong>{currency(totalAfterCustomerCredit)}</strong>
                      </article>
                    </div>
                    <div className="form-grid rep-checkout-form rep-checkout-form-steps">
                      <p className="form-hint">Cashier: {cashier || "-"}</p>
                      {customerName.trim() ? <p className="form-hint outstanding-text">Outstanding: {currency(selectedCustomerOutstanding)}</p> : null}
                      {customerName.trim() && selectedCustomerDiscountLimit > 0 ? <p className="form-hint">Discount Limit: {currency(selectedCustomerDiscountLimit)}</p> : null}
                      {customerName.trim() && selectedCustomerBundleDiscountLimit > 0 ? <p className="form-hint">Bundle Discount Limit: {currency(selectedCustomerBundleDiscountLimit)} per bundle</p> : null}
                      {customerName.trim() && selectedCustomerDiscountLimit > 0 && cartDiscountTotal > selectedCustomerDiscountLimit ? (
                        <p className="form-hint outstanding-text">Current discount {currency(cartDiscountTotal)} exceeds allowed limit.</p>
                      ) : null}
                      {selectedBundleViolation ? (
                        <p className="form-hint outstanding-text">
                          {selectedBundleViolation.lineName} exceeds bundle discount limit. Allowed {currency(selectedBundleViolation.allowedBundleDiscount)} for {selectedBundleViolation.fullBundles} bundle(s).
                        </p>
                      ) : null}
                      {customerName.trim() && selectedCustomerAvailableCredit > 0 ? (
                        <>
                          <p className="form-hint">Available Credit: {currency(selectedCustomerAvailableCredit)}</p>
                          <label className="form-hint">Apply Customer Credit</label>
                          <div className="checkout-inline-action">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={customerCreditDraft}
                              onChange={(e) => setCustomerCreditDraft(e.target.value)}
                              placeholder="Customer credit amount"
                            />
                            <button type="button" className="ghost" onClick={() => setCustomerCreditDraft(String(selectedCustomerAvailableCredit))}>
                              Use Full
                            </button>
                          </div>
                          {appliedCustomerCredit > 0 ? <p className="form-hint">Credit applied: {currency(appliedCustomerCredit)} • Payable now: {currency(totalAfterCustomerCredit)}</p> : null}
                        </>
                      ) : null}
                      {selectedSavedCustomer ? (
                        <>
                          <label className="form-hint">Customer Tel</label>
                          <div className="checkout-inline-action">
                            <input
                              value={customerPhoneDraft}
                              onChange={(e) => setCustomerPhoneDraft(e.target.value)}
                              placeholder="Customer phone"
                            />
                            <button type="button" className="ghost" onClick={saveBillingCustomerPhone} disabled={savingCustomerPhone}>
                              {savingCustomerPhone ? "Saving..." : "Save"}
                            </button>
                          </div>
                        </>
                      ) : null}
                      <label className="form-hint">Bill Discount Applied in Cart</label>
                      <select value={lorry} onChange={(e) => setLorry(e.target.value)}>
                        <option value="">Select delivery lorry</option>
                        {lorryLoadRows.map((row) => {
                          const remaining = Math.max(0, LORRY_CAPACITY - row.load);
                          const full = !row.isOverflow && remaining <= 0;
                          return (
                            <option key={row.name} value={row.name} disabled={full}>
                              {row.isOverflow
                                ? `${row.name} - Overflow bucket`
                                : (full ? `${row.name} - Lorry is full` : `${row.name} - ${remaining} left`)}
                            </option>
                          );
                        })}
                      </select>
                      <div className="form-hint lorry-capacity-note">
                        {lorryLoadRows.map((row) => {
                          const remaining = Math.max(0, LORRY_CAPACITY - row.load);
                          return (
                            <span key={row.name} className={!row.isOverflow && remaining <= 0 ? "outstanding-text" : ""}>
                              {row.isOverflow
                                ? `${row.name}: ${row.load} queued`
                                : `${row.name}: ${row.load}/${LORRY_CAPACITY} ${remaining <= 0 ? "• Lorry is full" : `• ${remaining} left`}`}
                            </span>
                          );
                        })}
                      </div>
                      <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
                        {PAYMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                      </select>
                      <p className="form-hint">Payment will be collected and confirmed at delivery.</p>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>

            {repBillingStep !== "cart" ? (
              <div className="rep-wizard-footer">
              <div className="rep-wizard-footer-copy">
                <strong>{repBillingSteps[repBillingStepIndex]?.label}</strong>
                <p>{customerName ? `${customerName} • ${cart.length} item(s)` : "Follow each step to finish the bill."}</p>
              </div>
              <div className="rep-wizard-footer-actions">
                {repBillingStep !== "customer" ? (
                  <button
                    type="button"
                    className="ghost rep-nav-circle rep-nav-circle-back"
                    onClick={() => setRepBillingStep(repBillingSteps[Math.max(0, repBillingStepIndex - 1)].key)}
                    aria-label="Back"
                  >
                    <span className="rep-nav-action-icon" aria-hidden="true">{"<"}</span>
                  </button>
                ) : (
                  <span className="rep-nav-placeholder" aria-hidden="true" />
                )}

                {repBillingStep === "customer" ? (
                  <button type="button" className="rep-nav-circle rep-nav-circle-next" aria-label="Next" onClick={() => setRepBillingStep("items")} disabled={!customerName.trim()}>
                    <span className="rep-nav-action-icon" aria-hidden="true">{">"}</span>
                  </button>
                ) : null}
                {repBillingStep === "items" ? (
                  <button type="button" className="rep-nav-circle rep-nav-circle-next" aria-label="Next" onClick={() => setRepBillingStep("cart")} disabled={!cart.length}>
                    <span className="rep-nav-action-icon" aria-hidden="true">{">"}</span>
                  </button>
                ) : null}
                {repBillingStep === "checkout" ? (
                  <button className="checkout rep-nav-action rep-nav-action-complete" type="button" onClick={checkout} disabled={!cart.length || savingCheckout}>
                    <span>{savingCheckout ? "Wait..." : "Done"}</span>
                    <span className="rep-nav-action-icon" aria-hidden="true">✓</span>
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
          {cart.length && repBillingStep !== "cart" ? (
            <button type="button" className="rep-cart-fab" onClick={() => setShowCartPopup(true)} aria-label="Open cart">
              <span>{cart.length}</span>
              Cart
            </button>
          ) : null}
        </main>
      ) : null}
      {cashierPage === "returns" ? (
        <main className="grid">
          <section className="panel">
            <h2>Returns</h2>
            <div className="form-grid">
              <p className="form-hint">Rep: {cashier || "-"}</p>
              <input
                value={returnCustomerName}
                onChange={(e) => {
                  setReturnCustomerName(e.target.value);
                  setShowReturnCustomerSuggestions(true);
                  setReturnSaleId("");
                  setReturnLinesDraft({});
                  setReturnError("");
                }}
                onFocus={() => setShowReturnCustomerSuggestions(true)}
                onBlur={() => setTimeout(() => setShowReturnCustomerSuggestions(false), 120)}
                placeholder="Type customer name"
              />
              {showReturnCustomerSuggestions && filteredReturnCustomerOptions.length ? (
                <div className="customer-suggestions">
                  {filteredReturnCustomerOptions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        setReturnCustomerName(name);
                        setShowReturnCustomerSuggestions(false);
                        setReturnSaleId("");
                        setReturnLinesDraft({});
                        setReturnError("");
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              ) : null}
              <select
                value={returnSaleId}
                onChange={(e) => { setReturnSaleId(e.target.value); setReturnLinesDraft({}); setReturnError(""); }}
                disabled={!returnCustomerName.trim()}
              >
                <option value="">{returnCustomerName.trim() ? "Select bill (Sale ID)" : "Select customer first"}</option>
                {returnSalesForCustomer.map((sale) => (
                  <option key={sale.id} value={sale.id}>
                    #{sale.id} • {new Date(sale.createdAt).toLocaleDateString()} • {currency(saleNetTotal(sale))}
                  </option>
                ))}
              </select>
              <input value={returnSaleId} onChange={(e) => { setReturnSaleId(e.target.value); setReturnLinesDraft({}); setReturnError(""); }} placeholder="Enter Sale ID (e.g. 00001)" />
            </div>
            {!returnSaleId ? <p className="form-hint">Select customer then bill, or type Sale ID manually to load bill items.</p> : null}
            {returnSaleId && !returnSale ? <p className="form-hint">Sale not found.</p> : null}
            {returnSale ? (
                <>
                  <article className="list-row">
                    <div>
                      <strong>Sale #{returnSale.id}</strong>
                      <p>{new Date(returnSale.createdAt).toLocaleString()}</p>
                      <p>{returnSale.customerName} • {returnSale.lorry || "-"}</p>
                    </div>
                    <strong>{currency(saleNetTotal(returnSale))}</strong>
                  </article>
                  <div className="return-draft-summary">
                    <article>
                      <span>Selected Qty</span>
                      <strong>{returnDraftSummary.qty}</strong>
                    </article>
                    <article>
                      <span>Good Returns</span>
                      <strong>{returnDraftSummary.goodQty}</strong>
                    </article>
                    <article>
                      <span>Damaged Returns</span>
                      <strong>{returnDraftSummary.damagedQty}</strong>
                    </article>
                    <article className="return-draft-summary-amount">
                      <span>Return Credit</span>
                      <strong>{currency(returnDraftSummary.amount)}</strong>
                    </article>
                  </div>
                  <div className="list">
                    {(returnSale.lines || []).map((line) => {
                      const sold = Number(line.quantity || 0);
                      const returned = Number(returnedQtyByProduct.get(line.productId) || 0);
                      const alreadyNotDelivered = Number(
                        (returnSale.deliveryAdjustments || []).reduce((acc, adjustment) => (
                          acc + (adjustment.lines || [])
                            .filter((item) => String(item.productId) === String(line.productId))
                            .reduce((lineAcc, item) => lineAcc + Number(item.quantity || 0), 0)
                        ), 0)
                      );
                      const soldEffective = Math.max(0, sold - alreadyNotDelivered);
                      const draft = returnLinesDraft[line.productId] || { quantity: "", condition: "good" };
                      const draftQty = Number(draft.quantity || 0);
                      const remainingBeforeDraft = Math.max(0, sold - returned - alreadyNotDelivered);
                      const remainingLive = Math.max(0, sold - returned - alreadyNotDelivered - (Number.isFinite(draftQty) ? draftQty : 0));
                      const preview = returnLinePreview(returnSale, line, Number.isFinite(draftQty) ? draftQty : 0);
                      const lineHasItemDiscount = Number(lineItemDiscount(line) || 0) > 0;
                      const lineHasBillDiscount = Number(returnSale.discountAmount || returnSale.discount || 0) > 0;
                      return (
                        <article key={line.productId} className="list-row return-line-card">
                            <div className="return-line-main">
                              <strong>{line.name}</strong>
                              <p>Ordered {sold} • Not Delivered {alreadyNotDelivered} • Sold {soldEffective} • Returned {returned} • Remaining {remainingLive}</p>
                              <p>Sold unit value {currency(line.price || 0)}</p>
                              {draftQty > 0 ? (
                                <p className="return-line-discount-note">
                                  Proportional bill discount {currency(preview.billDiscountShare || 0)}
                                </p>
                              ) : null}
                              {lineHasItemDiscount || lineHasBillDiscount ? (
                                <p className="return-line-discount-note">
                                  {lineHasItemDiscount ? `Item discount applied${lineHasBillDiscount ? " • " : ""}` : ""}
                                  {lineHasBillDiscount ? "Bill discount shared proportionally" : ""}
                                </p>
                            ) : null}
                            {draftQty > 0 ? (
                              <p className="return-line-credit">
                                Return credit {currency(preview.returnAmount)}
                              </p>
                            ) : null}
                          </div>
                          <div className="return-line-controls">
                            <input type="number" min="0" max={remainingBeforeDraft} value={draft.quantity} onChange={(e) => onReturnDraftChange(line.productId, { quantity: e.target.value })} placeholder="Qty" />
                            <select value={draft.condition} onChange={(e) => onReturnDraftChange(line.productId, { condition: e.target.value })}>
                              <option value="good">Good</option>
                            <option value="damaged">Expired / Damaged</option>
                          </select>
                        </div>
                      </article>
                    );
                  })}
                </div>
                {returnError ? <p className="form-hint">{returnError}</p> : null}
                <button type="button" onClick={submitReturnFromSale} disabled={savingReturn}>{savingReturn ? "Saving Return..." : "Submit Return"}</button>
              </>
            ) : null}
          </section>
        </main>
      ) : null}

      {cashierPage === "sales" ? (
        <main className="grid">
          <section className="panel rep-productivity-panel">
            <div className="rep-productivity-head">
              <div>
                <h2>My Productivity</h2>
                <p className="form-hint">Track your orders, value, bundles, and singles by date range.</p>
              </div>
              <div className="rep-productivity-filters">
                <label>
                  <span>From</span>
                  <input type="date" value={repProductivityDateFrom} onChange={(e) => setRepProductivityDateFrom(e.target.value)} />
                </label>
                <label>
                  <span>To</span>
                  <input type="date" value={repProductivityDateTo} onChange={(e) => setRepProductivityDateTo(e.target.value)} />
                </label>
              </div>
            </div>
            <div className="rep-productivity-grid">
              <article>
                <span>Orders</span>
                <strong>{repProductivityStats.orders}</strong>
              </article>
              <article>
                <span>Value</span>
                <strong>{currency(repProductivityStats.value)}</strong>
              </article>
              <article>
                <span>Total Qty</span>
                <strong>{repProductivityStats.qty}</strong>
              </article>
              <article>
                <span>Bundles</span>
                <strong>{repProductivityStats.bundles}</strong>
              </article>
              <article>
                <span>Singles</span>
                <strong>{repProductivityStats.singles}</strong>
              </article>
              <article>
                <span>Customers</span>
                <strong>{repProductivityStats.customers}</strong>
              </article>
            </div>
            <p className="form-hint rep-productivity-foot">Today quick view: {repSessionStats.orders} orders • {currency(repSessionStats.revenue)}</p>
          </section>
          <section className="panel rep-sales-panel">
            <h2>My Sales</h2>
            <input
              className="search-icon-input imperfect-search-input"
              value={repSalesSearch}
              onChange={(e) => setRepSalesSearch(e.target.value)}
              placeholder="Search my sales"
            />
            <div className="list rep-sales-list">
              {filteredRepSales.map((sale) => (
                <article key={sale.id} className="list-row rep-sale-card">
                  <div className="rep-sale-main">
                    <div className="rep-sale-id-row">
                      <strong>#{sale.id}</strong>
                      <span className={`rep-sale-payment rep-sale-payment-${String(sale.paymentType || "").toLowerCase()}`}>{sale.paymentType}</span>
                    </div>
                    <p className="rep-sale-meta">{new Date(sale.createdAt).toLocaleString()}</p>
                    <p className="rep-sale-customer">{sale.customerName}</p>
                    <p className="rep-sale-meta">Lorry: {sale.lorry || "-"}</p>
                  </div>
                  <div className="rep-sale-side">
                    <strong className="rep-sale-total">{currency(saleNetTotal(sale))}</strong>
                    <div className="sales-row-actions">
                      <button
                        type="button"
                        onClick={() => openSaleEdit(sale)}
                        disabled={Boolean(sale.deliveryConfirmedAt) || Boolean((sale.deliveryAdjustments || []).length) || (state.returns || []).some((ret) => String(ret.saleId) === String(sale.id))}
                      >
                        Edit
                      </button>
                      {String(sale.cashier || "").trim().toLowerCase() === String(cashier || "").trim().toLowerCase() ? (
                        <button
                          type="button"
                          className="row-danger"
                          onClick={() => deleteRepSale(sale)}
                          disabled={Boolean(sale.deliveryConfirmedAt) || Boolean((sale.deliveryAdjustments || []).length)}
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="panel">
            <h2>Recent Sales</h2>
            <input
              className="search-icon-input imperfect-search-input"
              value={repRecentSalesSearch}
              onChange={(e) => setRepRecentSalesSearch(e.target.value)}
              placeholder="Search recent sales"
            />
            <div className="list">
              {filteredRecentSales.map((sale) => (
                <article key={sale.id} className="list-row">
                  <div>
                    <strong>#{sale.id} ({sale.cashier || "-"})</strong>
                    <p>{new Date(sale.createdAt).toLocaleString()}</p>
                    <p>{sale.customerName} • {sale.paymentType} • {sale.lorry || "-"}</p>
                  </div>
                  <strong>{currency(saleNetTotal(sale))}</strong>
                </article>
              ))}
            </div>
          </section>
          <section className="panel">
            <h2>Rep Comparison</h2>
            <input
              className="search-icon-input imperfect-search-input"
              value={repComparisonSearch}
              onChange={(e) => setRepComparisonSearch(e.target.value)}
              placeholder="Search rep"
            />
            <div className="list">
              {filteredRepCompareRows.map((row) => (
                <article key={row.rep} className="list-row">
                  <div>
                    <strong>{row.rep}</strong>
                    <p>{row.bills} bill(s)</p>
                  </div>
                  <strong>{currency(row.revenue)}</strong>
                </article>
              ))}
            </div>
          </section>
        </main>
      ) : null}

      {cashierPage === "customers" ? (
        <main className="grid">
          <section className="panel rep-customers-panel">
            <div className="rep-customers-head">
              <h2>Saved Customers</h2>
              <p>Find customer details and outstanding balance quickly.</p>
            </div>
            <input
              className="search-icon-input rep-customers-search"
              value={repCustomerSearch}
              onChange={(e) => setRepCustomerSearch(e.target.value)}
              placeholder="Search customer by name"
            />
            <div className="list rep-customers-list">
              {filteredRepCustomers.length ? filteredRepCustomers.map((customer) => (
                <article key={customer.id} className="list-row rep-customer-card">
                  <div className="rep-customer-main">
                    <strong>{customer.name}</strong>
                    <p className="rep-customer-phone">{customer.phone || "-"}</p>
                    <p className="rep-customer-address">{customer.address || "-"}</p>
                  </div>
                  <div className="rep-customer-side">
                    <span className="rep-customer-side-label">Outstanding</span>
                    <strong className={Number(customerOutstandingMap.get(customer.name) || 0) > 0 ? "outstanding-text" : ""}>
                      {currency(customerOutstandingMap.get(customer.name) || 0)}
                    </strong>
                  </div>
                </article>
              )) : <p className="form-hint rep-customers-empty">No matching customers found.</p>}
            </div>
          </section>
        </main>
      ) : null}

      {editingSaleId ? (
        <div className="low-stock-modal" onClick={closeSaleEdit}>
          <div className="low-stock-modal-card rep-sale-edit-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Editing sale #{editingSaleId}</h3>
              <button type="button" className="ghost" onClick={closeSaleEdit}>Close</button>
            </div>
            <div className="admin-inline-form rep-sale-edit-form">
              <label className="rep-sale-field rep-sale-edit-payment">
                <span>Payment Method</span>
                <select value={saleEditPaymentType} onChange={(e) => setSaleEditPaymentType(e.target.value)}>
                  {PAYMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="rep-sale-field rep-sale-edit-payment">
                <span>Total Bill Discount (LKR)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={saleEditBillDiscount}
                  onChange={(e) => setSaleEditBillDiscount(e.target.value)}
                  placeholder="0.00"
                />
              </label>
              <p className="form-hint rep-sale-edit-title">Editable subtotal: {currency(saleEditSubTotal)}</p>
              {(() => {
                const saleBeingEdited = (state.sales || []).find((sale) => String(sale.id) === String(editingSaleId));
                const discountLimit = (state.customers || [])
                  .filter((item) => String(item.name || "").trim().toLowerCase() === String(saleBeingEdited?.customerName || "").trim().toLowerCase())
                  .reduce((max, item) => Math.max(max, Number(item.discountLimit || 0)), 0);
                const bundleDiscountLimit = (state.customers || [])
                  .filter((item) => String(item.name || "").trim().toLowerCase() === String(saleBeingEdited?.customerName || "").trim().toLowerCase())
                  .reduce((max, item) => Math.max(max, Number(item.bundleDiscountLimit || 0)), 0);
                const totalDiscount = totalDiscountApplied({ lines: saleEditLines, billDiscount: saleEditBillDiscount });
                const bundleDiscountViolation = findBundleDiscountViolation({ lines: saleEditLines, bundleDiscountLimit });
                return (
                  <>
                    {discountLimit > 0 ? (
                      <p className={`form-hint rep-sale-edit-title${totalDiscount > discountLimit ? " outstanding-text" : ""}`}>
                        Discount limit: {currency(discountLimit)} • Current discount: {currency(totalDiscount)}
                      </p>
                    ) : null}
                    {bundleDiscountLimit > 0 ? (
                      <p className={`form-hint rep-sale-edit-title${bundleDiscountViolation ? " outstanding-text" : ""}`}>
                        Bundle discount limit: {currency(bundleDiscountLimit)} per bundle
                      </p>
                    ) : null}
                  </>
                );
              })()}
              {saleEditLines.map((line) => (
                <div key={line.productId} className="rep-sale-edit-row">
                  <div className="rep-sale-edit-name">{line.name}</div>
                  <div className="rep-sale-edit-controls">
                    <label className="rep-sale-field">
                      <span>Qty</span>
                      <input type="number" min="1" value={line.quantity} onChange={(e) => setSaleEditLines((current) => current.map((l) => (l.productId === line.productId ? { ...l, quantity: e.target.value } : l)))} />
                    </label>
                    <label className="rep-sale-field">
                      <span>Type</span>
                      <select value={line.itemDiscountMode || "amount"} onChange={(e) => setSaleEditLines((current) => current.map((l) => {
                        if (l.productId !== line.productId) return l;
                        const nextMode = e.target.value === "percent" ? "percent" : "amount";
                        const currentValue = Number(l.itemDiscount || 0);
                        const base = Number(l.basePrice || 0);
                        return {
                          ...l,
                          itemDiscountMode: nextMode,
                          itemDiscount: nextMode === "percent" ? Math.min(currentValue, 100) : Math.min(currentValue, base)
                        };
                      }))}>
                        <option value="amount">Rs.</option>
                        <option value="percent">%</option>
                      </select>
                    </label>
                    <label className="rep-sale-field">
                      <span>Item Discount</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.itemDiscount ?? 0}
                        onChange={(e) => setSaleEditLines((current) => current.map((l) => {
                          if (l.productId !== line.productId) return l;
                          const parsed = Number(e.target.value || 0);
                          if (!Number.isFinite(parsed) || parsed < 0) return l;
                          const base = Number(l.basePrice || 0);
                          return {
                            ...l,
                            itemDiscount: l.itemDiscountMode === "percent" ? Math.min(parsed, 100) : Math.min(parsed, base)
                          };
                        }))}
                        placeholder="Disc"
                      />
                    </label>
                    <button type="button" className="row-danger" onClick={() => setSaleEditLines((current) => current.filter((l) => l.productId !== line.productId))}>Remove</button>
                  </div>
                </div>
              ))}
              {saleEditError ? <p className="form-hint">{saleEditError}</p> : null}
              <div className="rep-sale-edit-actions">
                <button type="button" onClick={saveSaleEdit} disabled={savingSaleEdit}>{savingSaleEdit ? "Saving..." : "Save Edit"}</button>
                <button type="button" className="ghost" onClick={closeSaleEdit}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {cashierPage === "stock" ? (
        <main className="grid">
          <section className="panel rep-stock-panel">
            <h2>Stock Overview</h2>
            <div className="rep-stock-metrics">
              <article>
                <p>Remaining Items</p>
                <strong>{repStockSummary.remainingItems}</strong>
              </article>
              <article className="danger">
                <p>Damaged / Expired</p>
                <strong>{repStockSummary.damagedItems}</strong>
              </article>
              <article>
                <p>Affected SKUs</p>
                <strong>{repStockSummary.damagedSkus}</strong>
              </article>
            </div>
          </section>

          <section className="panel rep-stock-panel">
            <h2>Remaining Stock</h2>
            <input
              className="search-icon-input imperfect-search-input"
              value={repStockSearch}
              onChange={(e) => setRepStockSearch(e.target.value)}
              placeholder="Search stock item"
            />
            <div className="rep-stock-table">
              <header>
                <button type="button" className="th-sort" onClick={() => toggleRepStockSort("name")}>Item{repStockSortMark("name")}</button>
                <button type="button" className="th-sort" onClick={() => toggleRepStockSort("billingPrice")}>B.Price (LKR){repStockSortMark("billingPrice")}</button>
                <button type="button" className="th-sort" onClick={() => toggleRepStockSort("mrp")}>MRP{repStockSortMark("mrp")}</button>
                <button type="button" className="th-sort" onClick={() => toggleRepStockSort("remaining")}>Remaining{repStockSortMark("remaining")}</button>
              </header>
              {sortedRepStockRows.map((row) => (
                <article key={`remain-${row.id}`}>
                  <span>{row.name}</span>
                  <span>{formatLkrValue(row.billingPrice || 0)}</span>
                  <span>{formatLkrValue(row.mrp || 0)}</span>
                  <span>{row.remaining}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="panel rep-stock-panel">
            <h2>Damaged / Expired Stock</h2>
            <div className="rep-stock-table rep-stock-table-danger">
              <header>
                <button type="button" className="th-sort" onClick={() => toggleRepStockSort("name")}>Item{repStockSortMark("name")}</button>
                <button type="button" className="th-sort" onClick={() => toggleRepStockSort("billingPrice")}>B.Price (LKR){repStockSortMark("billingPrice")}</button>
                <button type="button" className="th-sort" onClick={() => toggleRepStockSort("mrp")}>MRP{repStockSortMark("mrp")}</button>
                <button type="button" className="th-sort" onClick={() => toggleRepStockSort("damaged")}>Damaged Qty{repStockSortMark("damaged")}</button>
              </header>
              {sortedRepDamagedRows.length ? sortedRepDamagedRows
                .map((row) => (
                  <article key={`damaged-${row.id}`}>
                    <span>{row.name}</span>
                    <span>{formatLkrValue(row.billingPrice || 0)}</span>
                    <span>{formatLkrValue(row.mrp || 0)}</span>
                    <span>{row.damaged}</span>
                  </article>
                )) : <p className="form-hint">No damaged/expired items recorded yet.</p>}
            </div>
          </section>
        </main>
      ) : null}

      {showCustomerPicker ? (
        <div className="low-stock-modal rep-fullscreen-sheet-backdrop" onClick={() => setShowCustomerPicker(false)}>
          <div className="low-stock-modal-card rep-fullscreen-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Select Customer</h3>
              <button type="button" className="ghost" onClick={() => setShowCustomerPicker(false)}>Close</button>
            </div>
            <div className="rep-fullscreen-sheet-body">
              <input
                className="search-icon-input rep-step-input"
                value={customerName}
                onChange={(e) => {
                  setCustomerName(e.target.value);
                  setShowCustomerSuggestions(true);
                }}
                onFocus={() => setShowCustomerSuggestions(true)}
                placeholder="Search customer"
              />
              <div className="rep-step-list rep-step-customer-list rep-sheet-list">
                {filteredCustomerOptions.length ? filteredCustomerOptions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="rep-step-list-row"
                    onClick={() => {
                      setCustomerName(name);
                      setShowCustomerSuggestions(false);
                      setShowCustomerPicker(false);
                    }}
                  >
                    <div>
                      <strong>{name}</strong>
                      <p>{customerOutstandingMap.get(name) ? `Outstanding ${currency(customerOutstandingMap.get(name))}` : "No outstanding"}</p>
                    </div>
                    <span>Use</span>
                  </button>
                )) : <p className="form-hint">Type the customer name to search.</p>}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {showCartPopup ? (
        <div className="low-stock-modal rep-fullscreen-sheet-backdrop" onClick={() => setShowCartPopup(false)}>
          <div className="low-stock-modal-card kiosk-cart-popup" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>My Cart</h3>
              <button type="button" className="ghost" onClick={() => setShowCartPopup(false)}>Close</button>
            </div>
            <div className="kiosk-cart-popup-body">
              <div className="list cart-list rep-cart-list rep-sheet-list">
                {cart.length ? cart.map((line) => (
                  <article className="list-row rep-cart-step-row" key={`sheet-${line.productId}`}>
                    <div className="cart-line-head">
                      <strong>{line.name}</strong>
                      <p>{currency(lineBasePrice(line))} each • Item Disc {currency(lineItemDiscount(line))} • Net {currency(lineFinalPrice(line))}</p>
                    </div>
                    <div className="cart-line-controls">
                      <div className="rep-cart-qty-cluster">
                        <div className="qty-box">
                          <button type="button" onClick={() => updateQty(line.productId, line.quantity - 1)}>-</button>
                          <span>{line.quantity}</span>
                          <button type="button" onClick={() => updateQty(line.productId, line.quantity + 1)}>+</button>
                        </div>
                        {getBundleSize(line) > 0 ? (
                          <div className="rep-cart-bundle-actions">
                            <button type="button" className="rep-cart-bundle-step rep-cart-bundle-step-down" onClick={() => updateQtyByBundle(line, "down")}>-1 Bundle</button>
                            <button type="button" className="rep-cart-bundle-step rep-cart-bundle-step-up" onClick={() => updateQtyByBundle(line, "up")}>+1 Bundle</button>
                          </div>
                        ) : null}
                      </div>
                      <div className="rep-cart-discount-row" onClick={(e) => e.stopPropagation()}>
                        <select
                          className="rep-cart-discount-mode"
                          value={line.itemDiscountMode || "amount"}
                          onChange={(e) => updateItemDiscountMode(line.productId, e.target.value)}
                        >
                          <option value="amount">Rs.</option>
                          <option value="percent">%</option>
                        </select>
                        <input
                          className="rep-cart-discount-input"
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.itemDiscount ?? 0}
                          onChange={(e) => updateItemDiscount(line.productId, e.target.value)}
                          placeholder="Item discount"
                        />
                        {lineItemDiscount(line) > 0 ? (
                          <strong className="rep-cart-discount-applied">-{currency(lineItemDiscount(line))}</strong>
                        ) : null}
                      </div>
                    </div>
                  </article>
                )) : <p className="form-hint">Cart is empty.</p>}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {showItemSizePicker ? (
        <div className="low-stock-modal rep-fullscreen-sheet-backdrop" onClick={() => setShowItemSizePicker(false)}>
          <div className="low-stock-modal-card rep-fullscreen-sheet rep-size-products-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>{activeItemSize || "Select Size"} Items</h3>
              <button type="button" className="ghost" onClick={() => setShowItemSizePicker(false)}>Close</button>
            </div>
            <div className="rep-fullscreen-sheet-body">
              <input
                className="search-icon-input rep-step-input"
                value={sizeProductSearch}
                onChange={(e) => setSizeProductSearch(e.target.value)}
                placeholder="Search product / sku / category"
              />
              <div className="rep-step-list rep-step-product-list rep-sheet-list">
                {activeSizeProducts.length ? activeSizeProducts.map((product) => (
                  <article
                    key={`size-${product.id}`}
                    className={`rep-product-pick-card ${expandedSizeProductId === String(product.id) ? "expanded" : "collapsed"}`}
                    onClick={() => setExpandedSizeProductId((current) => (current === String(product.id) ? "" : String(product.id)))}
                  >
                    <div className="rep-product-pick-copy">
                      <strong>{productDisplayName(product)}</strong>
                      <p>{product.sku} • {product.category}</p>
                      <p>{currency(productSalePrice(product))} • <span className={getCatalogStock(product) <= lowStockThreshold ? "stock-low-text" : ""}>Stock {getCatalogStock(product)}</span></p>
                      {getBundleSize(product) > 0 ? <p className="catalog-bundle-rule">{getBundleSize(product)} units = 1 bundle</p> : null}
                      {expandedSizeProductId !== String(product.id) ? <p className="catalog-edit-hint">Tap card to edit qty</p> : null}
                    </div>
                    {expandedSizeProductId === String(product.id) ? (
                    <div className="rep-product-pick-actions" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="number"
                        min="1"
                        value={catalogQtyDrafts[product.id] ?? ""}
                        onChange={(e) => setCatalogQtyDrafts((current) => ({ ...current, [product.id]: e.target.value }))}
                        placeholder="Custom qty"
                        className="catalog-qty-input"
                      />
                      <div className="catalog-quick-groups">
                        {getBundleSize(product) > 0 ? (
                          <div className="catalog-quick-group catalog-quick-group-bundle">
                            <span className="catalog-quick-group-label">Bundles</span>
                            <div className="catalog-quick-group-actions">
                              <button
                                className="catalog-bundle-minus-btn"
                                type="button"
                                onTouchStart={triggerAddHaptic}
                                onPointerDown={triggerAddHaptic}
                                onClick={() => removeFromCartWithQty(product, getBundleSize(product))}
                                disabled={Number(cartQtyByProduct.get(product.id) || 0) < getBundleSize(product)}
                              >
                                -1
                              </button>
                              <button
                                className="catalog-bundle-btn"
                                type="button"
                                onTouchStart={triggerAddHaptic}
                                onPointerDown={triggerAddHaptic}
                                onClick={() => addToCartWithQty(product, getBundleSize(product))}
                                disabled={getCatalogStock(product) < getBundleSize(product)}
                              >
                                +1
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <div className="catalog-quick-group catalog-quick-group-single">
                          <span className="catalog-quick-group-label">Singles</span>
                          <div className="catalog-quick-group-actions">
                            <button
                              className="catalog-single-minus-btn"
                              type="button"
                              onTouchStart={triggerAddHaptic}
                              onPointerDown={triggerAddHaptic}
                              onClick={() => removeFromCartWithQty(product, 1)}
                              disabled={Number(cartQtyByProduct.get(product.id) || 0) <= 0}
                            >
                              -1
                            </button>
                            <button
                              className="catalog-single-btn"
                              type="button"
                              onTouchStart={triggerAddHaptic}
                              onPointerDown={triggerAddHaptic}
                              onClick={() => addToCartWithQty(product, 1)}
                              disabled={getCatalogStock(product) <= 0}
                            >
                              +1
                            </button>
                          </div>
                        </div>
                      </div>
                      <button
                        className="add-feedback-btn"
                        type="button"
                        onTouchStart={triggerAddHaptic}
                        onPointerDown={triggerAddHaptic}
                        onClick={() => addToCart(product)}
                        disabled={
                          getCatalogStock(product) <= 0
                          || !Number.isFinite(Number(catalogQtyDrafts[product.id]))
                          || Math.floor(Number(catalogQtyDrafts[product.id])) <= 0
                        }
                      >
                        Add Qty
                      </button>
                      <p className="catalog-in-cart-chip">
                        In cart: {Number(cartQtyByProduct.get(product.id) || 0)}
                        {getBundleSize(product) > 0 ? ` (${Math.floor(Number(cartQtyByProduct.get(product.id) || 0) / getBundleSize(product))} bundle${Math.floor(Number(cartQtyByProduct.get(product.id) || 0) / getBundleSize(product)) === 1 ? "" : "s"} + ${Number(cartQtyByProduct.get(product.id) || 0) % getBundleSize(product)} single${(Number(cartQtyByProduct.get(product.id) || 0) % getBundleSize(product)) === 1 ? "" : "s"})` : " singles"}
                      </p>
                    </div>
                    ) : null}
                  </article>
                )) : <p className="form-hint">No items in this size for the current search.</p>}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {showAddCustomer ? (
        <div className="low-stock-modal" onClick={() => setShowAddCustomer(false)}>
          <div className="low-stock-modal-card customer-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Add Customer</h3>
              <button type="button" onClick={() => setShowAddCustomer(false)}>Close</button>
            </div>
            <div className="admin-inline-form">
              <input
                value={customerDraft.name}
                onChange={(e) => setCustomerDraft((current) => ({ ...current, name: e.target.value }))}
                placeholder="Customer name"
              />
              <input
                value={customerDraft.phone}
                onChange={(e) => setCustomerDraft((current) => ({ ...current, phone: e.target.value }))}
                placeholder="Mobile"
              />
              <textarea
                value={customerDraft.address}
                onChange={(e) => setCustomerDraft((current) => ({ ...current, address: e.target.value }))}
                placeholder="Address"
              />
              {customerDraftError ? <p className="form-hint">{customerDraftError}</p> : null}
              <div>
                <button type="button" onClick={saveQuickCustomer} disabled={savingCustomer}>
                  {savingCustomer ? "Saving..." : "Save Customer"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const REPORT_SUBPAGES = [
  { id: "item-wise", label: "Item Wise Report" },
  { id: "sales-wise", label: "Sales Wise Report" },
  { id: "cheque-summary", label: "Cheque Summary" },
  { id: "customer-wise", label: "Customer Wise Report" },
  { id: "rep-outstanding", label: "Rep Wise Customer Outstanding" },
  { id: "delivery-report", label: "Delivery Report" }
];

const AdminView = ({ state, dashboard, message, onError, requestConfirm, onSaleDeleted, user }) => {
  const [showLowStock, setShowLowStock] = useState(false);
  const [showChequeAlertDetails, setShowChequeAlertDetails] = useState(false);
  const [showChequeSummaryDetails, setShowChequeSummaryDetails] = useState(false);
  const [showCreditLimitAlertDetails, setShowCreditLimitAlertDetails] = useState(false);
  const [selectedRep, setSelectedRep] = useState("");
  const [chartDateFrom, setChartDateFrom] = useState("");
  const [chartDateTo, setChartDateTo] = useState("");
  const [repDateFrom, setRepDateFrom] = useState("");
  const [repDateTo, setRepDateTo] = useState("");
  const [itemReportLorry, setItemReportLorry] = useState("all");
  const [itemDateFrom, setItemDateFrom] = useState("");
  const [itemDateTo, setItemDateTo] = useState("");
  const [salesDateFrom, setSalesDateFrom] = useState("");
  const [salesDateTo, setSalesDateTo] = useState("");
  const [salesTimeFrom, setSalesTimeFrom] = useState("");
  const [salesTimeTo, setSalesTimeTo] = useState("");
  const [loadingDateFrom, setLoadingDateFrom] = useState("");
  const [loadingDateTo, setLoadingDateTo] = useState("");
  const [loadingTimeFrom, setLoadingTimeFrom] = useState("");
  const [loadingTimeTo, setLoadingTimeTo] = useState("");
  const [customerReportSearch, setCustomerReportSearch] = useState("");
  const [customerPanelSearch, setCustomerPanelSearch] = useState("");
  const [stockPanelSearch, setStockPanelSearch] = useState("");
  const [stockLogSearch, setStockLogSearch] = useState("");
  const [stockLogDateFrom, setStockLogDateFrom] = useState("");
  const [stockLogDateTo, setStockLogDateTo] = useState("");
  const [staffSearch, setStaffSearch] = useState("");
  const [deliveriesSearch, setDeliveriesSearch] = useState("");
  const [deliveredItemsSearch, setDeliveredItemsSearch] = useState("");
  const [itemWiseSearch, setItemWiseSearch] = useState("");
  const [salesWiseSearch, setSalesWiseSearch] = useState("");
  const [customerWiseSearch, setCustomerWiseSearch] = useState("");
  const [repOutstandingSearch, setRepOutstandingSearch] = useState("");
  const [reportDeliverySearch, setReportDeliverySearch] = useState("");
  const [loadingsSearch, setLoadingsSearch] = useState("");
  const [selectedLoadingPanel, setSelectedLoadingPanel] = useState(ORDER_LORRIES[0]);
  const [deliveryLorry, setDeliveryLorry] = useState("all");
  const [deliveryDateFrom, setDeliveryDateFrom] = useState("");
  const [deliveryDateTo, setDeliveryDateTo] = useState("");
  const [deliveryTimeFrom, setDeliveryTimeFrom] = useState("");
  const [deliveryTimeTo, setDeliveryTimeTo] = useState("");
  const [deliveriesView, setDeliveriesView] = useState("deliveries");
  const [deliveryReportDateFrom, setDeliveryReportDateFrom] = useState("");
  const [deliveryReportDateTo, setDeliveryReportDateTo] = useState("");
  const [dashboardProfitDateFrom, setDashboardProfitDateFrom] = useState("");
  const [dashboardProfitDateTo, setDashboardProfitDateTo] = useState("");
  const [reportDeliveryLorry, setReportDeliveryLorry] = useState("all");
  const [reportDeliveryDateFrom, setReportDeliveryDateFrom] = useState("");
  const [reportDeliveryDateTo, setReportDeliveryDateTo] = useState("");
  const [activePage, setActivePage] = useState("dashboard");
  const [notice, setNotice] = useState("");

  const [customerForm, setCustomerForm] = useState({ id: "", name: "", phone: "", address: "", openingOutstanding: "", creditLimit: "", discountLimit: "", bundleDiscountLimit: "", outstandingAdjustment: "", outstandingAdjustmentReason: "" });
  const [staffForm, setStaffForm] = useState({ id: "", authUserId: "", name: "", role: "", phone: "", username: "", password: "", authRole: "cashier" });
  const [stockMode, setStockMode] = useState("add");
  const [stockForm, setStockForm] = useState({ productId: "", quantity: "", stock: "", sku: "", invoicePrice: "", billingPrice: "", mrp: "" });
  const [stockSearch, setStockSearch] = useState("");
  const [showStockSuggestions, setShowStockSuggestions] = useState(false);
  const [newStockItemForm, setNewStockItemForm] = useState({ sku: "", category: "General", billingPrice: "", invoicePrice: "", mrp: "" });
  const stockFileRef = useRef(null);
  const customerFileRef = useRef(null);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [showStaffForm, setShowStaffForm] = useState(false);
  const [showStockForm, setShowStockForm] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState(false);
  const [deletingSaleId, setDeletingSaleId] = useState("");
  const [editingAdminSaleId, setEditingAdminSaleId] = useState("");
  const [adminSaleEditLines, setAdminSaleEditLines] = useState([]);
  const [adminSaleEditError, setAdminSaleEditError] = useState("");
  const [savingAdminSaleEdit, setSavingAdminSaleEdit] = useState(false);
  const [repOutstandingDetailRep, setRepOutstandingDetailRep] = useState("");
  const [viewSaleId, setViewSaleId] = useState("");
  const [customerDetailName, setCustomerDetailName] = useState("");
  const [deliverySaleId, setDeliverySaleId] = useState("");
  const [deliveryDraft, setDeliveryDraft] = useState({});
  const [deliveryCashReceived, setDeliveryCashReceived] = useState("");
  const [deliveryChequeAmount, setDeliveryChequeAmount] = useState("");
  const [deliveryChequeNo, setDeliveryChequeNo] = useState("");
  const [deliveryChequeDate, setDeliveryChequeDate] = useState("");
  const [deliveryChequeBank, setDeliveryChequeBank] = useState("");
  const [deliveryError, setDeliveryError] = useState("");
  const [savingDelivery, setSavingDelivery] = useState(false);
  const [resettingLorryCount, setResettingLorryCount] = useState(false);
  const [loadingMarkPendingKey, setLoadingMarkPendingKey] = useState("");
  const [stockSummaryDetailMode, setStockSummaryDetailMode] = useState("");
  const [tableSort, setTableSort] = useState({});
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authUsers, setAuthUsers] = useState([]);
  const [managerAccessPending, setManagerAccessPending] = useState(false);
  const [reportSubpage, setReportSubpage] = useState("item-wise");
  const [reportMenuOpen, setReportMenuOpen] = useState(false);
  const reportMenuRef = useRef(null);
  const isManager = String(user?.role || "").toLowerCase() === "manager";
  const isAdmin = String(user?.role || "").toLowerCase() === "admin";
  const managerFullAccessEnabled = Boolean(state?.settings?.managerFullAccess);
  const canManageStock = !isManager || managerFullAccessEnabled;
  const canManageCustomerOpeningOutstanding = !isManager || managerFullAccessEnabled;
  const canManageCustomerLimits = !isManager || managerFullAccessEnabled;
  const canManageUsers = !isManager || managerFullAccessEnabled;
  const canManageOutstandingAdjustment = isAdmin;

  useEffect(() => {
    if (!notice) return;
    const isErrorNotice = /(error|invalid|required|cannot|unable|failed|not found|select|enter|type|exceeds|no\s.+to\sedit)/i.test(String(notice));
    if (!isErrorNotice) return;
    onError?.(notice);
    setNotice("");
  }, [notice, onError]);

  useEffect(() => {
    setMobileNavOpen(false);
    scrollViewportToTop();
  }, [activePage]);

  useEffect(() => {
    if (!reportMenuOpen) return;
    const handlePointerDown = (event) => {
      if (!reportMenuRef.current?.contains(event.target)) {
        setReportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [reportMenuOpen]);

  useEffect(() => {
    if (!canManageUsers) {
      setAuthUsers([]);
      return;
    }
    fetchAuthUsers()
      .then((rows) => setAuthUsers(Array.isArray(rows) ? rows : []))
      .catch(() => setAuthUsers([]));
  }, [canManageUsers, state.staff]);

  const inDateTimeRange = (iso, fromDate, toDate, fromTime, toTime) => {
    const value = new Date(iso).getTime();
    if (Number.isNaN(value)) return false;
    const fromBound = fromDate ? new Date(`${fromDate}T${fromTime || "00:00"}:00`).getTime() : null;
    const toBound = toDate ? new Date(`${toDate}T${toTime || "23:59"}:59`).getTime() : null;
    if (fromBound !== null && !Number.isNaN(fromBound) && value < fromBound) return false;
    if (toBound !== null && !Number.isNaN(toBound) && value > toBound) return false;
    return true;
  };

  const toggleSort = (table, key) => {
    setTableSort((current) => {
      const prev = current[table];
      if (prev?.key === key) {
        return { ...current, [table]: { key, dir: prev.dir === "asc" ? "desc" : "asc" } };
      }
      return { ...current, [table]: { key, dir: "asc" } };
    });
  };

  const sortMark = (table, key) => {
    const sort = tableSort[table];
    if (!sort || sort.key !== key) return "";
    return sort.dir === "asc" ? " ▲" : " ▼";
  };

  const sortRows = (rows, table, defaultKey, getters) => {
    const sort = tableSort[table] || { key: defaultKey, dir: "asc" };
    const getValue = getters[sort.key] || (() => "");
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      const aNum = typeof av === "number" ? av : Number.NaN;
      const bNum = typeof bv === "number" ? bv : Number.NaN;
      if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return (aNum - bNum) * factor;
      return String(av || "").localeCompare(String(bv || ""), undefined, { numeric: true, sensitivity: "base" }) * factor;
    });
  };
  const chartData = useMemo(() => {
    const base = [];
    const today = new Date();
    const endDate = chartDateTo ? new Date(`${chartDateTo}T00:00:00`) : today;
    const startDate = chartDateFrom
      ? new Date(`${chartDateFrom}T00:00:00`)
      : (() => {
          const d = new Date(endDate);
          d.setDate(endDate.getDate() - 7);
          return d;
        })();
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) return [];
    const cursor = new Date(startDate);
    let guard = 0;
    while (cursor <= endDate && guard < 62) {
      const key = toColomboDateKey(cursor);
      const short = cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const daySales = state.sales.filter((sale) => toColomboDateKey(sale.createdAt) === key);
      const count = daySales.length;
      const revenue = daySales.reduce((acc, sale) => acc + saleNetTotal(sale), 0);
      base.push({ key, short, count, revenue: Number(revenue.toFixed(2)) });
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }
    return base;
  }, [state.sales, chartDateFrom, chartDateTo]);

  const maxCount = Math.max(1, ...chartData.map((item) => item.count));
  const repChartData = useMemo(() => {
    const map = new Map();
    const isRepRole = (value) => {
      const role = String(value || "").trim().toLowerCase();
      return role === "cashier" || role === "rep";
    };
    for (const member of (state.staff || [])) {
      if (!isRepRole(member.role)) continue;
      const repName = String(member.name || "").trim();
      if (!repName) continue;
      map.set(repName, 0);
    }
    for (const authUser of (authUsers || [])) {
      if (!isRepRole(authUser.role)) continue;
      const repName = String(authUser.name || authUser.username || "").trim();
      if (!repName) continue;
      map.set(repName, map.get(repName) || 0);
    }
    for (const sale of state.sales) {
      const saleDay = toColomboDateKey(sale.createdAt);
      if (repDateFrom && saleDay && saleDay < repDateFrom) continue;
      if (repDateTo && saleDay && saleDay > repDateTo) continue;
      const rep = sale.cashier || "Unknown";
      map.set(rep, (map.get(rep) || 0) + 1);
    }
    return [...map.entries()]
      .map(([rep, count]) => ({ rep, count }))
      .sort((a, b) => b.count - a.count);
  }, [state.sales, state.staff, authUsers, repDateFrom, repDateTo]);

  const filteredRepChartData = useMemo(() => {
    if (!selectedRep) return repChartData;
    return repChartData.filter((row) => row.rep === selectedRep);
  }, [selectedRep, repChartData]);
  const repMaxCount = Math.max(1, ...filteredRepChartData.map((item) => item.count), 0);

  const productInfoById = useMemo(() => {
    return new Map(state.products.map((item) => [
      item.id,
      { name: item.name, sku: item.sku, size: item.size, category: item.category }
    ]));
  }, [state.products]);

  const reportSales = useMemo(
    () => (state.sales || []).filter((sale) => {
      const saleDate = toColomboDateKey(sale.createdAt);
      if (!saleDate) return false;
      const saleTime = toColomboTimeKey(sale.createdAt);
      const safeSaleTime = saleTime || "00:00";
      const saleDateTimeKey = `${saleDate} ${safeSaleTime}`;

      if (salesDateFrom) {
        const fromDateTimeKey = `${salesDateFrom} ${salesTimeFrom || "00:00"}`;
        if (saleDateTimeKey < fromDateTimeKey) return false;
      } else if (salesTimeFrom && safeSaleTime < salesTimeFrom) {
        return false;
      }

      if (salesDateTo) {
        const toDateTimeKey = `${salesDateTo} ${salesTimeTo || "23:59"}`;
        if (saleDateTimeKey > toDateTimeKey) return false;
      } else if (salesTimeTo && safeSaleTime > salesTimeTo) {
        return false;
      }

      return true;
    }),
    [state.sales, salesDateFrom, salesDateTo, salesTimeFrom, salesTimeTo]
  );

  const itemReportSales = useMemo(
    () => (state.sales || []).filter((sale) => inDateRange(sale.createdAt, itemDateFrom, itemDateTo)),
    [state.sales, itemDateFrom, itemDateTo]
  );

  const itemWiseRows = useMemo(() => {
    const salesSource = itemReportLorry === "all"
      ? itemReportSales
      : itemReportSales.filter((sale) => sale.lorry === itemReportLorry);
    const map = new Map();
    for (const sale of salesSource) {
      const returnedByProduct = saleReturnedQtyByProduct(sale, state.returns || []);
      const undeliveredByProduct = saleUndeliveredQtyByProduct(sale);
      for (const line of (sale.lines || [])) {
        const key = line.productId || line.name;
        const info = productInfoById.get(line.productId) || { name: line.name || "Unknown Item", sku: "-", size: "", category: "" };
        const row = map.get(key) || { key, name: info.name, sku: info.sku, size: info.size || "", category: info.category || "", qty: 0, bills: 0, revenue: 0 };
        const lineState = effectiveSaleLineState(sale, line, { returnedByProduct, undeliveredByProduct });
        row.qty += lineState.effectiveQty;
        row.revenue += lineState.effectiveRevenue;
        row.bills += 1;
        map.set(key, row);
      }
    }
    return [...map.values()].sort((a, b) => b.qty - a.qty);
  }, [itemReportLorry, itemReportSales, productInfoById, state.returns]);

  const loadingRowsByLorry = useMemo(() => {
    const loadingMarks = state?.settings?.loadingRowMarks || {};
    const buildRows = (lorryName) => {
      const map = new Map();
      for (const sale of state.sales) {
        if (!inDateTimeRange(sale.createdAt, loadingDateFrom, loadingDateTo, loadingTimeFrom, loadingTimeTo)) continue;
        if (sale.lorry !== lorryName) continue;
        for (const line of (sale.lines || [])) {
          const key = line.productId || line.name;
          const info = productInfoById.get(line.productId) || { name: line.name || "Unknown Item", sku: "-", size: "", category: "" };
          const row = map.get(key) || { key, productId: line.productId || key, name: info.name, sku: info.sku, size: info.size || "", category: info.category || "", qty: 0, value: 0 };
          const qty = Number(line.quantity || 0);
          row.qty += qty;
          row.value += saleLineRevenueForQty(sale, line, qty);
          map.set(key, row);
        }
      }
      const returnedByProduct = new Map();
      for (const ret of (state.returns || [])) {
        const retSale = (state.sales || []).find((s) => String(s.id) === String(ret.saleId));
        if (!retSale || retSale.lorry !== lorryName) continue;
        if (!inDateTimeRange(ret.createdAt, loadingDateFrom, loadingDateTo, loadingTimeFrom, loadingTimeTo)) continue;
        for (const line of (ret.lines || [])) {
          returnedByProduct.set(line.productId, (returnedByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
        }
      }
      const deliveredByProduct = new Map();
      for (const sale of state.sales) {
        if (!inDateTimeRange(sale.createdAt, loadingDateFrom, loadingDateTo, loadingTimeFrom, loadingTimeTo)) continue;
        if (sale.lorry !== lorryName) continue;
        if (!sale.deliveryConfirmedAt) continue;
        const returnedByProduct = saleReturnedQtyByProduct(sale, state.returns || []);
        const undeliveredByProduct = saleUndeliveredQtyByProduct(sale);
        for (const line of (sale.lines || [])) {
          const lineKey = line.productId || line.name;
          const lineState = effectiveSaleLineState(sale, line, { returnedByProduct, undeliveredByProduct });
          const current = deliveredByProduct.get(lineKey) || { qty: 0, value: 0 };
          current.qty += lineState.effectiveQty;
          current.value += lineState.effectiveRevenue;
          deliveredByProduct.set(lineKey, current);
        }
      }
      return [...map.values()]
        .map((row) => {
          const bundleSize = getBundleSize(row);
          const bundles = bundleSize ? Math.floor(row.qty / bundleSize) : 0;
          const balance = bundleSize ? row.qty % bundleSize : row.qty;
          const deliveredRaw = deliveredByProduct.get(row.key) || { qty: 0, value: 0 };
          const deliveredQty = Math.max(0, Number(deliveredRaw.qty || 0));
          const deliveredValue = Number(deliveredRaw.value || 0);
          const markKey = buildLoadingMarkKey({
            lorry: lorryName,
            rowKey: row.key,
            dateFrom: loadingDateFrom,
            timeFrom: loadingTimeFrom,
            dateTo: loadingDateTo,
            timeTo: loadingTimeTo
          });
          return {
            ...row,
            bundleSize,
            bundles,
            balance,
            orderedQty: row.qty,
            orderedValue: row.value,
            deliveredQty,
            deliveredValue,
            markKey,
            loaded: Boolean(loadingMarks[markKey]?.loaded)
          };
        })
        .sort((a, b) => b.orderedQty - a.orderedQty);
    };

    return ORDER_LORRIES.reduce((acc, lorryName) => {
      acc[lorryName] = buildRows(lorryName);
      return acc;
    }, {});
  }, [state.sales, state.returns, state?.settings?.loadingRowMarks, loadingDateFrom, loadingDateTo, loadingTimeFrom, loadingTimeTo, productInfoById]);

  const salesWiseRows = useMemo(() => {
    return reportSales.map((sale) => ({
      id: sale.id,
      when: new Date(sale.createdAt).toLocaleDateString(),
      whenTs: new Date(sale.createdAt).getTime(),
      rep: sale.cashier || "-",
      lorry: sale.lorry || "-",
      total: saleNetTotal(sale),
      raw: sale
    }));
  }, [reportSales]);

  const customerWiseRows = useMemo(() => {
    const map = new Map();
    for (const sale of reportSales) {
      const key = sale.customerName || "Walk-in";
      const current = map.get(key) || { name: key, orders: 0, spent: 0, lastAt: "" };
      current.orders += 1;
      current.spent += saleNetTotal(sale);
      if (!current.lastAt || new Date(sale.createdAt).getTime() > new Date(current.lastAt).getTime()) {
        current.lastAt = sale.createdAt;
      }
      map.set(key, current);
    }
    return [...map.values()].sort((a, b) => b.spent - a.spent);
  }, [reportSales]);

  const customerCreditMap = useMemo(() => {
    const map = new Map();
    for (const entry of (state.customerCredits || [])) {
      const key = String(entry.customerName || "").trim();
      if (!key) continue;
      const remainingAmount = Number(entry.remainingAmount ?? entry.amount ?? 0);
      if (remainingAmount <= 0) continue;
      map.set(key, Number(map.get(key) || 0) + remainingAmount);
    }
    return map;
  }, [state.customerCredits]);

  const customerRows = useMemo(() => {
    const map = new Map();
    for (const sale of state.sales) {
      const key = sale.customerName || "Walk-in";
      const existing = map.get(key) || { name: key, orders: 0, spent: 0, outstanding: 0, openingOutstanding: 0, outstandingAdjustment: 0, outstandingAdjustmentReason: "", liveOutstandingRaw: 0, creditLimit: 0, discountLimit: 0, bundleDiscountLimit: 0, availableCredit: 0, phone: "", address: "", oldestOutstandingSale: null, topOutstandingRep: "" };
      existing.orders += 1;
      existing.spent += saleNetTotal(sale);
      const saleOutstanding = Number(
        sale.outstandingAmount !== undefined
          ? sale.outstandingAmount
          : (sale.paymentType === "credit" ? saleNetTotal(sale) : 0)
      ) || 0;
      existing.outstanding += saleOutstanding;
      existing.liveOutstandingRaw += saleOutstanding;
      if (saleOutstanding > 0) {
        const currentOldest = existing.oldestOutstandingSale ? new Date(existing.oldestOutstandingSale.createdAt || 0).getTime() : Infinity;
        const candidate = new Date(sale.createdAt || 0).getTime();
        if (candidate < currentOldest) {
          existing.oldestOutstandingSale = sale;
        }
        existing.topOutstandingRep = existing.topOutstandingRep || String(sale.cashier || "-").trim() || "-";
      }
      map.set(key, existing);
    }
    for (const customer of (state.customers || [])) {
      const existing = map.get(customer.name) || { name: customer.name, orders: 0, spent: 0, outstanding: 0, openingOutstanding: 0, outstandingAdjustment: 0, outstandingAdjustmentReason: "", liveOutstandingRaw: 0, creditLimit: 0, discountLimit: 0, bundleDiscountLimit: 0, availableCredit: 0, phone: "", address: "", oldestOutstandingSale: null, topOutstandingRep: "" };
      const openingOutstanding = Math.max(Number(existing.openingOutstanding || 0), Number(customer.openingOutstanding || 0));
      const outstandingAdjustment = Math.max(Number(existing.outstandingAdjustment || 0), Number(customer.outstandingAdjustment || 0));
      const outstandingAdjustmentReason = String(customer.outstandingAdjustmentReason || "").trim() || String(existing.outstandingAdjustmentReason || "").trim();
      const creditLimit = Math.max(Number(existing.creditLimit || 0), Number(customer.creditLimit || 0));
      const discountLimit = Math.max(Number(existing.discountLimit || 0), Number(customer.discountLimit || 0));
      const bundleDiscountLimit = Math.max(Number(existing.bundleDiscountLimit || 0), Number(customer.bundleDiscountLimit || 0));
      const phone = String(customer.phone || "").trim() || String(existing.phone || "").trim();
      const address = String(customer.address || "").trim() || String(existing.address || "").trim();
      const liveOutstanding = Math.max(0, Number(existing.liveOutstandingRaw || 0));
      const aging = existing.oldestOutstandingSale
        ? customerOutstandingAging(existing.oldestOutstandingSale)
        : (openingOutstanding > 0 ? { daysLeft: null, label: "Opening due" } : { daysLeft: null, label: "-" });
      map.set(customer.name, {
        ...existing,
        ...customer,
        phone,
        address,
        openingOutstanding,
        outstandingAdjustment,
        outstandingAdjustmentReason,
        creditLimit,
        discountLimit,
        bundleDiscountLimit,
        liveOutstandingRaw: liveOutstanding,
        outstanding: Math.max(0, Number((liveOutstanding + openingOutstanding - outstandingAdjustment).toFixed(2))),
        outstandingDaysLeft: aging.daysLeft,
        outstandingDaysLabel: aging.label
      });
    }
    for (const [name, credit] of customerCreditMap.entries()) {
      const existing = map.get(name) || { name, orders: 0, spent: 0, outstanding: 0, openingOutstanding: 0, outstandingAdjustment: 0, outstandingAdjustmentReason: "", liveOutstandingRaw: 0, creditLimit: 0, discountLimit: 0, bundleDiscountLimit: 0, availableCredit: 0, outstandingDaysLeft: null, outstandingDaysLabel: "-", topOutstandingRep: "" };
      existing.availableCredit = Number(credit || 0);
      map.set(name, existing);
    }
    return [...map.values()].sort((a, b) => b.spent - a.spent);
  }, [state.sales, state.customers, customerCreditMap]);
  const filteredCustomerRows = useMemo(() => {
    const term = customerPanelSearch.trim().toLowerCase();
    if (!term) return customerRows;
    return customerRows.filter((row) =>
      String(row.name || "").toLowerCase().includes(term)
      || String(row.phone || "").toLowerCase().includes(term)
      || String(row.address || "").toLowerCase().includes(term)
    );
  }, [customerRows, customerPanelSearch]);
  const sortedCustomerRows = useMemo(
    () => sortRows(filteredCustomerRows, "customers", "name", {
      name: (row) => row.name,
      phone: (row) => row.phone || "",
      orders: (row) => Number(row.orders || 0),
      spent: (row) => Number(row.spent || 0),
      openingOutstanding: (row) => Number(row.openingOutstanding || 0),
      outstanding: (row) => Number(row.outstanding || 0),
      daysLeft: (row) => {
        const value = row.outstandingDaysLeft;
        return value === null || value === undefined ? Number.POSITIVE_INFINITY : Number(value);
      },
      availableCredit: (row) => Number(row.availableCredit || 0)
    }),
    [filteredCustomerRows, tableSort]
  );
  const customerPageSummary = useMemo(() => {
    const rows = sortedCustomerRows || [];
    const totalCustomers = rows.length;
    let totalOrders = 0;
    let totalSpent = 0;
    let totalOutstanding = 0;
    let totalAvailableCredit = 0;
    let activeCustomers = 0;
    let customersWithOutstanding = 0;
    let topCustomer = null;
    for (const row of rows) {
      const orders = Number(row.orders || 0);
      const spent = Number(row.spent || 0);
      const outstanding = Number(row.outstanding || 0);
      const availableCredit = Number(row.availableCredit || 0);
      totalOrders += orders;
      totalSpent += spent;
      totalOutstanding += outstanding;
      totalAvailableCredit += availableCredit;
      if (orders > 0) activeCustomers += 1;
      if (outstanding > 0) customersWithOutstanding += 1;
      if (!topCustomer || spent > Number(topCustomer.spent || 0)) topCustomer = row;
    }
    return {
      totalCustomers,
      activeCustomers,
      customersWithOutstanding,
      totalOrders,
      totalSpent: Number(totalSpent.toFixed(2)),
      totalOutstanding: Number(totalOutstanding.toFixed(2)),
      totalAvailableCredit: Number(totalAvailableCredit.toFixed(2)),
      averageOrderValue: totalOrders > 0 ? Number((totalSpent / totalOrders).toFixed(2)) : 0,
      topCustomerName: topCustomer?.name || "-",
      topCustomerSpent: Number(topCustomer?.spent || 0)
    };
  }, [sortedCustomerRows]);
  const totalOutstandingExcludingToday = Math.max(
    0,
    Number((Number(customerPageSummary?.totalOutstanding || 0) - Number(dashboard?.todayOutstanding || 0)).toFixed(2))
  );
  const overdueCreditSummary = useMemo(() => {
    const now = Date.now();
    const byCustomer = new Map();
    for (const sale of (state.sales || [])) {
      const outstanding = Number(sale.outstandingAmount || 0);
      if (outstanding <= 0) continue;
      const createdAtTs = new Date(sale.createdAt || 0).getTime();
      if (!Number.isFinite(createdAtTs)) continue;
      const overdueDays = Math.floor((now - createdAtTs) / 86400000);
      if (overdueDays <= 14) continue;
      const key = String(sale.customerName || "Walk-in").trim() || "Walk-in";
      const row = byCustomer.get(key) || { customer: key, amount: 0, bills: 0, maxDays: 0 };
      row.amount += outstanding;
      row.bills += 1;
      row.maxDays = Math.max(row.maxDays, overdueDays);
      byCustomer.set(key, row);
    }
    const rows = [...byCustomer.values()].sort((a, b) => b.amount - a.amount);
    return {
      count: rows.length,
      total: Number(rows.reduce((acc, row) => acc + Number(row.amount || 0), 0).toFixed(2)),
      top: rows[0] || null,
      rows
    };
  }, [state.sales]);
  const creditLimitAlertSummary = useMemo(() => {
    const rows = (customerRows || [])
      .filter((row) => Number(row.creditLimit || 0) > 0)
      .filter((row) => Number(row.outstanding || 0) > Number(row.creditLimit || 0))
      .map((row) => ({
        customer: row.name,
        phone: row.phone || "-",
        rep: row.topOutstandingRep || "-",
        creditLimit: Number(row.creditLimit || 0),
        outstanding: Number(row.outstanding || 0),
        daysLabel: row.outstandingDaysLabel || "-",
        exceededBy: Number((Number(row.outstanding || 0) - Number(row.creditLimit || 0)).toFixed(2))
      }))
      .sort((a, b) => Number(b.exceededBy || 0) - Number(a.exceededBy || 0));
    return {
      count: rows.length,
      totalExceeded: Number(rows.reduce((acc, row) => acc + Number(row.exceededBy || 0), 0).toFixed(2)),
      top: rows[0] || null,
      rows
    };
  }, [customerRows]);
  const upcomingChequeSummary = useMemo(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = localDateKey(tomorrow);
    const rows = [];
    for (const sale of (state.sales || [])) {
      for (const payment of salePayments(sale)) {
        if (String(payment.method || "").toLowerCase() !== "cheque") continue;
        if (!isChequePaymentPending(payment)) continue;
        const chequeDate = localDateKey(payment.chequeDate);
        if (!chequeDate || chequeDate !== tomorrowKey) continue;
        rows.push({
          saleId: sale.id,
          customer: sale.customerName || "Walk-in",
          amount: Number(payment.amount || 0),
          chequeNo: payment.chequeNo || "-",
          bank: payment.chequeBank || "-",
          rep: sale.cashier || "-"
        });
      }
    }
    return {
      date: tomorrowKey,
      count: rows.length,
      total: Number(rows.reduce((acc, row) => acc + Number(row.amount || 0), 0).toFixed(2)),
      rows
    };
  }, [state.sales]);
  const dashboardProfitSummary = useMemo(() => {
    const productsById = new Map((state.products || []).map((product) => [String(product.id), product]));
    const scopedSales = (state.sales || []).filter((sale) => inDateRange(sale.createdAt, dashboardProfitDateFrom, dashboardProfitDateTo));
    let netRevenue = 0;
    let invoiceCost = 0;

    for (const sale of scopedSales) {
      netRevenue += saleNetTotal(sale);
      const returnedByProduct = saleReturnedQtyByProduct(sale, state.returns || []);
      const undeliveredByProduct = saleUndeliveredQtyByProduct(sale);
      for (const line of (sale.lines || [])) {
        const lineState = effectiveSaleLineState(sale, line, { returnedByProduct, undeliveredByProduct });
        const product = productsById.get(String(line.productId || ""));
        const unitInvoice = Number(product?.invoicePrice ?? 0);
        invoiceCost += lineState.effectiveQty * unitInvoice;
      }
    }

    const profit = Number((netRevenue - invoiceCost).toFixed(2));
    return {
      from: dashboardProfitDateFrom,
      to: dashboardProfitDateTo,
      filteredSalesCount: scopedSales.length,
      revenue: Number(netRevenue.toFixed(2)),
      cost: Number(invoiceCost.toFixed(2)),
      profit,
      margin: netRevenue > 0 ? Number(((profit / netRevenue) * 100).toFixed(1)) : 0
    };
  }, [dashboardProfitDateFrom, dashboardProfitDateTo, state.products, state.returns, state.sales]);
  const customerDetailData = useMemo(() => {
    const key = String(customerDetailName || "").trim().toLowerCase();
    if (!key) return null;
    const row = customerRows.find((item) => String(item.name || "").trim().toLowerCase() === key);
    if (!row) return null;
    const sales = (state.sales || [])
      .filter((sale) => String(sale.customerName || "").trim().toLowerCase() === key)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const totalBills = sales.length;
    const totalQty = sales.reduce((acc, sale) => {
      const returnedByProduct = saleReturnedQtyByProduct(sale, state.returns || []);
      const undeliveredByProduct = saleUndeliveredQtyByProduct(sale);
      return acc + (sale.lines || []).reduce((lineAcc, line) => {
        const lineState = effectiveSaleLineState(sale, line, { returnedByProduct, undeliveredByProduct });
        return lineAcc + lineState.effectiveQty;
      }, 0);
    }, 0);
    const averageBillValue = totalBills ? Number((Number(row.spent || 0) / totalBills).toFixed(2)) : 0;
    const saleIds = new Set(sales.map((sale) => String(sale.id)));
    const returnSummary = (state.returns || []).reduce((acc, entry) => {
      if (!saleIds.has(String(entry.saleId))) return acc;
      (entry.lines || []).forEach((line) => {
        acc.qty += Number(line.quantity || 0);
        acc.value += Number(line.returnAmount || 0);
      });
      return acc;
    }, { qty: 0, value: 0 });
    return {
      row,
      totalBills,
      totalQty,
      returnedQty: returnSummary.qty,
      returnedValue: Number(returnSummary.value.toFixed(2)),
      averageBillValue,
      lastSaleAt: sales[0]?.createdAt || "",
      openingOutstanding: Number(row.openingOutstanding || 0),
      outstandingAdjustment: Number(row.outstandingAdjustment || 0),
      outstandingAdjustmentReason: String(row.outstandingAdjustmentReason || "").trim(),
      liveSaleOutstanding: Number(row.liveOutstandingRaw || 0),
      availableCredit: Number(row.availableCredit || 0),
      recentSales: sales.slice(0, 4)
    };
  }, [customerDetailName, customerRows, state.sales, state.returns]);

  const stockRows = useMemo(() => {
    return [...state.products].sort((a, b) => a.stock - b.stock);
  }, [state.products]);
  const filteredStockRows = useMemo(() => {
    const term = stockPanelSearch.trim().toLowerCase();
    if (!term) return stockRows;
    return stockRows.filter((row) =>
      String(row.name || "").toLowerCase().includes(term)
      || String(row.sku || "").toLowerCase().includes(term)
      || String(row.size || "").toLowerCase().includes(term)
    );
  }, [stockRows, stockPanelSearch]);
  const sortedStockRows = useMemo(
    () => sortRows(filteredStockRows, "stock", "name", {
      name: (row) => row.name,
      size: (row) => row.size || "",
      sku: (row) => row.sku,
      invoicePrice: (row) => Number(row.invoicePrice ?? 0),
      billingPrice: (row) => Number(row.billingPrice ?? row.price ?? 0),
      mrp: (row) => Number(row.mrp ?? row.price ?? 0),
      totalBundles: (row) => {
        const bundleSize = getBundleSize(row);
        return bundleSize > 0 ? Math.floor(Number(row.stock || 0) / bundleSize) : 0;
      },
      stock: (row) => Number(row.stock || 0)
    }),
    [filteredStockRows, tableSort]
  );
  const stockPageSummary = useMemo(() => {
    const rows = sortedStockRows || [];
    const totalSkus = rows.length;
    const totalUnits = rows.reduce((acc, row) => acc + Number(row.stock || 0), 0);
    const totalBundles = rows.reduce((acc, row) => {
      const bundleSize = getBundleSize(row);
      return acc + (bundleSize > 0 ? Math.floor(Number(row.stock || 0) / bundleSize) : 0);
    }, 0);
    const lowStockThreshold = Number(state?.settings?.lowStockThreshold ?? 25);
    const lowStockCount = rows.filter((row) => Number(row.stock || 0) <= lowStockThreshold).length;
    const outOfStockCount = rows.filter((row) => Number(row.stock || 0) <= 0).length;
      const inventoryCost = Number(rows.reduce((acc, row) => (
        acc + (Number(row.stock || 0) * Number(row.billingPrice ?? row.price ?? 0))
      ), 0).toFixed(2));
      const inventoryInvoice = Number(rows.reduce((acc, row) => (
        acc + (Number(row.stock || 0) * Number(row.invoicePrice ?? 0))
      ), 0).toFixed(2));
      const inventoryMrp = Number(rows.reduce((acc, row) => (
        acc + (Number(row.stock || 0) * Number(row.mrp ?? row.price ?? 0))
      ), 0).toFixed(2));
    const topStockItem = rows.reduce(
      (best, row) => (Number(row.stock || 0) > Number(best?.stock || -1) ? row : best),
      null
    );
    return {
      totalSkus,
      totalUnits,
      totalBundles,
      lowStockCount,
        outOfStockCount,
        inventoryInvoice,
        inventoryCost,
        inventoryMrp,
      topStockName: topStockItem?.name || topStockItem?.sku || "-",
      topStockUnits: Number(topStockItem?.stock || 0)
    };
  }, [sortedStockRows, state?.settings?.lowStockThreshold]);
  const stockSummaryDetailRows = useMemo(() => {
    const rows = sortedStockRows || [];
    const lowStockThreshold = Number(state?.settings?.lowStockThreshold ?? 25);
    if (stockSummaryDetailMode === "bundles") {
      return rows
        .map((row) => {
          const bundleSize = getBundleSize(row);
          const totalBundles = bundleSize > 0 ? Math.floor(Number(row.stock || 0) / bundleSize) : 0;
          return { ...row, totalBundles, bundleSize };
        })
        .filter((row) => Number(row.bundleSize || 0) > 0 && Number(row.totalBundles || 0) > 0);
    }
    if (stockSummaryDetailMode === "low") {
      return rows.filter((row) => Number(row.stock || 0) > 0 && Number(row.stock || 0) <= lowStockThreshold);
    }
    if (stockSummaryDetailMode === "out") {
      return rows.filter((row) => Number(row.stock || 0) <= 0);
    }
    return [];
  }, [sortedStockRows, state?.settings?.lowStockThreshold, stockSummaryDetailMode]);

  const adminReturnRows = useMemo(() => {
    const rows = [];
    for (const ret of (state.returns || [])) {
      for (const line of (ret.lines || [])) {
        rows.push({
          id: `${ret.id}-${line.productId}-${line.condition}`,
          saleId: ret.saleId,
          item: line.name || line.productId,
          qty: Number(line.quantity || 0),
          amount: Number(line.returnAmount || 0),
          rep: ret.rep || "-",
          reason: line.condition === "good" ? "Good" : "Expired / Damaged",
          at: ret.createdAt
        });
      }
    }
    return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [state.returns]);
  const sortedAdminReturnRows = useMemo(
    () => sortRows(adminReturnRows, "returns", "at", {
      saleId: (row) => Number(row.saleId || 0),
      item: (row) => String(row.item || ""),
      qty: (row) => Number(row.qty || 0),
      amount: (row) => Number(row.amount || 0),
      rep: (row) => String(row.rep || ""),
      reason: (row) => String(row.reason || ""),
      at: (row) => new Date(row.at || 0).getTime()
    }),
    [adminReturnRows, tableSort]
  );
  const filteredStockMovementRows = useMemo(() => {
    const term = String(stockLogSearch || "").trim().toLowerCase();
    return (state.stockMovements || [])
      .filter((entry) => inDateRange(entry.at, stockLogDateFrom, stockLogDateTo))
      .filter((entry) => {
        if (!term) return true;
        return [
          entry.name,
          entry.sku,
          entry.by,
          entry.action,
          entry.productId
        ].some((value) => String(value || "").toLowerCase().includes(term));
      })
      .map((entry) => ({
        id: entry.id || `${entry.productId || "p"}-${entry.at || ""}`,
        at: entry.at || "",
        atLabel: entry.at ? new Date(entry.at).toLocaleString() : "-",
        product: entry.name || "-",
        sku: entry.sku || "-",
        beforeStock: Number(entry.beforeStock || 0),
        changeQty: Number(entry.changeQty || 0),
        afterStock: Number(entry.afterStock || 0),
        by: entry.by || "-",
        action: String(entry.action || "-").replace(/_/g, " "),
        atTs: new Date(entry.at || 0).getTime()
      }));
  }, [state.stockMovements, stockLogDateFrom, stockLogDateTo, stockLogSearch]);
  const sortedStockMovementRows = useMemo(() => {
    const getters = {
      at: (row) => Number(row.atTs || 0),
      product: (row) => String(row.product || ""),
      sku: (row) => String(row.sku || ""),
      beforeStock: (row) => Number(row.beforeStock || 0),
      changeQty: (row) => Number(row.changeQty || 0),
      afterStock: (row) => Number(row.afterStock || 0),
      by: (row) => String(row.by || ""),
      action: (row) => String(row.action || "")
    };
    if (!tableSort.stockLog) {
      return [...filteredStockMovementRows].sort((a, b) => Number(b.atTs || 0) - Number(a.atTs || 0));
    }
    return sortRows(filteredStockMovementRows, "stockLog", "at", getters);
  }, [filteredStockMovementRows, tableSort]);

  const stockSearchMatches = useMemo(() => {
    const term = stockSearch.trim().toLowerCase();
    if (!term) return state.products.slice(0, 8);
    return state.products
      .filter((item) => item.name.toLowerCase().includes(term) || item.sku.toLowerCase().includes(term))
      .slice(0, 8);
  }, [stockSearch, state.products]);

  const staffRows = useMemo(() => {
    const map = new Map();
    const keyForName = (value) => String(value || "").trim().toLowerCase();
    for (const sale of state.sales) {
      const name = sale.cashier || "Unknown";
      const key = keyForName(name);
      const existing = map.get(key) || { name, orders: 0, revenue: 0, role: "", phone: "", username: "", authRole: "", authUserId: "", staffId: "" };
      existing.orders += 1;
      existing.revenue += saleNetTotal(sale);
      map.set(key, existing);
    }
    for (const member of (state.staff || [])) {
      const key = keyForName(member.name);
      const existing = map.get(key) || { name: member.name, orders: 0, revenue: 0, username: "", authRole: "", authUserId: "" };
      map.set(key, { ...existing, ...member, staffId: member.id });
    }
    for (const authUser of (authUsers || [])) {
      const key = keyForName(authUser.name || authUser.username);
      const existing = map.get(key) || { name: authUser.name || authUser.username, orders: 0, revenue: 0, role: "", phone: "", staffId: "" };
      map.set(key, {
        ...existing,
        name: authUser.name || existing.name,
        username: authUser.username || existing.username || "",
        authRole: authUser.role || existing.authRole || "",
        authUserId: authUser.id || existing.authUserId || ""
      });
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [state.sales, state.staff, authUsers]);
  const sortedStaffRows = useMemo(
    () => sortRows(staffRows, "staff", "name", {
      name: (row) => row.name,
      username: (row) => row.username || "",
      role: (row) => row.authRole || row.role || "",
      orders: (row) => Number(row.orders || 0),
      revenue: (row) => Number(row.revenue || 0)
    }),
    [staffRows, tableSort]
  );
  const staffPageSummary = useMemo(() => {
    const rows = sortedStaffRows || [];
    const totalStaff = rows.length;
    const activeStaff = rows.filter((row) => Number(row.orders || 0) > 0).length;
    const totalOrders = rows.reduce((acc, row) => acc + Number(row.orders || 0), 0);
    const totalRevenue = Number(rows.reduce((acc, row) => acc + Number(row.revenue || 0), 0).toFixed(2));
    const avgRevenuePerStaff = totalStaff ? Number((totalRevenue / totalStaff).toFixed(2)) : 0;
    const topPerformer = rows.reduce(
      (best, row) => (Number(row.revenue || 0) > Number(best?.revenue || -1) ? row : best),
      null
    );
    return {
      totalStaff,
      activeStaff,
      totalOrders,
      totalRevenue,
      avgRevenuePerStaff,
      topPerformerName: topPerformer?.name || "-",
      topPerformerOrders: Number(topPerformer?.orders || 0),
      topPerformerRevenue: Number(topPerformer?.revenue || 0)
    };
  }, [sortedStaffRows]);

  const sortedItemWiseRows = useMemo(
    () => sortRows(itemWiseRows, "itemWise", "name", {
      name: (row) => row.name,
      sku: (row) => row.sku,
      qty: (row) => Number(row.qty || 0),
      bundles: (row) => {
        const { bundles } = getBundleBreakdown(row);
        return bundles;
      },
      singles: (row) => {
        const { singles } = getBundleBreakdown(row);
        return singles;
      }
    }),
    [itemWiseRows, tableSort]
  );

  const sortedSalesWiseRows = useMemo(
    () => sortRows(salesWiseRows, "salesWise", "when", {
      id: (row) => Number(row.id || 0),
      when: (row) => Number(row.whenTs || 0),
      lorry: (row) => String(row.lorry || ""),
      total: (row) => Number(row.total || 0)
    }),
    [salesWiseRows, tableSort]
  );

  const filteredCustomerWiseRows = useMemo(() => {
    const term = customerReportSearch.trim().toLowerCase();
    if (!term) return customerWiseRows;
    return customerWiseRows.filter((row) => String(row.name || "").toLowerCase().includes(term));
  }, [customerWiseRows, customerReportSearch]);
  const sortedCustomerWiseRows = useMemo(
    () => sortRows(filteredCustomerWiseRows, "customerWise", "spent", {
      name: (row) => row.name,
      orders: (row) => Number(row.orders || 0),
      spent: (row) => Number(row.spent || 0),
      lastAt: (row) => (row.lastAt ? new Date(row.lastAt).getTime() : 0)
    }),
    [filteredCustomerWiseRows, tableSort]
  );

  const sortedLoadingByLorry = useMemo(
    () => LOADING_PANEL_CONFIG.reduce((acc, panel) => {
      acc[panel.name] = sortRows(loadingRowsByLorry[panel.name] || [], panel.sortKey, "orderedQty", {
        sku: (row) => row.sku || "",
        size: (row) => row.size || "",
        name: (row) => row.name,
        orderedQty: (row) => Number(row.orderedQty || 0),
        orderedValue: (row) => Number(row.orderedValue || 0),
        deliveredQty: (row) => Number(row.deliveredQty || 0),
        deliveredValue: (row) => Number(row.deliveredValue || 0),
        bundles: (row) => Number(row.bundles || 0),
        singles: (row) => Number(row.balance || 0),
        loaded: (row) => (row.loaded ? 1 : 0)
      });
      return acc;
    }, {}),
    [loadingRowsByLorry, tableSort]
  );

  const salesRangeTotal = useMemo(
    () => Number(sortedSalesWiseRows.reduce((acc, row) => acc + Number(row.total || 0), 0).toFixed(2)),
    [sortedSalesWiseRows]
  );
  const chequePaymentEntries = useMemo(() => {
    return (state.sales || []).flatMap((sale) => (
      salePayments(sale)
        .filter((payment) => String(payment.method || "").toLowerCase() === "cheque")
        .filter((payment) => isChequePaymentPending(payment))
        .filter((payment) => Number(payment.amount || 0) > 0)
        .map((payment, index) => ({
          rowId: `${sale.id || "sale"}-${payment.id || index}-${payment.createdAt || sale.createdAt || ""}`,
          saleId: sale.id || "-",
          saleCreatedAt: sale.createdAt || "",
          customer: sale.customerName || "Walk-in",
          rep: sale.cashier || "-",
          outstanding: Number(sale.outstandingAmount || 0),
          amount: Number(payment.amount || 0),
          chequeNo: payment.chequeNo || sale.chequeNo || "-",
          chequeDate: payment.chequeDate || sale.chequeDate || "-",
          bank: payment.chequeBank || sale.chequeBank || "-",
          createdAtTs: new Date(payment.createdAt || sale.createdAt || 0).getTime()
        }))
    ));
  }, [state.sales]);
  const chequeReportSummary = useMemo(() => {
    const chequeCount = chequePaymentEntries.length;
    const totalChequeAmount = Number(chequePaymentEntries.reduce((acc, row) => acc + Number(row.amount || 0), 0).toFixed(2));
    const outstandingBySale = new Map();
    for (const row of chequePaymentEntries) {
      const key = String(row.saleId || "");
      if (!key) continue;
      if (!outstandingBySale.has(key)) outstandingBySale.set(key, Number(row.outstanding || 0));
    }
    const totalOutstanding = Number(
      [...outstandingBySale.values()].reduce((acc, value) => acc + Number(value || 0), 0).toFixed(2)
    );
    const avgChequeAmount = chequeCount ? Number((totalChequeAmount / chequeCount).toFixed(2)) : 0;
    const latestCheque = chequePaymentEntries
      .slice()
      .sort((a, b) => b.createdAtTs - a.createdAtTs)[0];
    return {
      chequeCount,
      totalChequeAmount,
      totalOutstanding,
      avgChequeAmount,
      latestChequeNo: latestCheque?.chequeNo || "-",
      latestChequeDate: latestCheque?.chequeDate || "-",
      latestChequeBank: latestCheque?.bank || "-"
    };
  }, [chequePaymentEntries]);
  const chequeSummaryRows = useMemo(() => {
    return chequePaymentEntries
      .map((row) => ({
        rowId: row.rowId,
        saleId: row.saleId,
        date: row.saleCreatedAt ? new Date(row.saleCreatedAt).toLocaleDateString() : "-",
        customer: row.customer,
        amount: Number(row.amount || 0),
        chequeNo: row.chequeNo,
        chequeDate: row.chequeDate,
        bank: row.bank,
        rep: row.rep,
        createdAtTs: row.createdAtTs
      }))
      .sort((a, b) => b.createdAtTs - a.createdAtTs);
  }, [chequePaymentEntries]);
  const sortedChequeSummaryRows = useMemo(
    () => sortRows(chequeSummaryRows, "chequeSummary", "createdAt", {
      saleId: (row) => Number(row.saleId || 0),
      date: (row) => String(row.date || ""),
      customer: (row) => String(row.customer || ""),
      amount: (row) => Number(row.amount || 0),
      chequeNo: (row) => String(row.chequeNo || ""),
      chequeDate: (row) => String(row.chequeDate || ""),
      bank: (row) => String(row.bank || ""),
      rep: (row) => String(row.rep || ""),
      createdAt: (row) => Number(row.createdAtTs || 0)
    }),
    [chequeSummaryRows, tableSort]
  );
  const repOutstandingRows = useMemo(() => {
    const map = new Map();
    for (const sale of reportSales) {
      const outstanding = Number(sale.outstandingAmount || 0);
      if (outstanding <= 0) continue;
      const rep = String(sale.cashier || "-").trim() || "-";
      const row = map.get(rep) || { rep, bills: 0, customers: new Set(), outstanding: 0 };
      row.bills += 1;
      row.outstanding += outstanding;
      row.customers.add(String(sale.customerName || "Walk-in").trim() || "Walk-in");
      map.set(rep, row);
    }
    return [...map.values()]
      .map((row) => ({
        rep: row.rep,
        bills: row.bills,
        customers: row.customers.size,
        outstanding: Number(row.outstanding.toFixed(2))
      }))
      .sort((a, b) => b.outstanding - a.outstanding);
  }, [reportSales]);
  const repOutstandingDetailRows = useMemo(() => {
    const repKey = String(repOutstandingDetailRep || "").trim();
    if (!repKey) return [];
    const map = new Map();
    for (const sale of reportSales) {
      const outstanding = Number(sale.outstandingAmount || 0);
      if (outstanding <= 0) continue;
      if ((String(sale.cashier || "-").trim() || "-") !== repKey) continue;
      const customerName = String(sale.customerName || "Walk-in").trim() || "Walk-in";
      const row = map.get(customerName) || { customerName, bills: 0, outstanding: 0, oldestOutstandingSale: null };
      row.bills += 1;
      row.outstanding += outstanding;
      const saleTime = new Date(sale.createdAt || 0).getTime();
      const oldestTime = row.oldestOutstandingSale ? new Date(row.oldestOutstandingSale.createdAt || 0).getTime() : Number.POSITIVE_INFINITY;
      if (!row.oldestOutstandingSale || saleTime < oldestTime) {
        row.oldestOutstandingSale = sale;
      }
      map.set(customerName, row);
    }
    return [...map.values()]
      .map((row) => ({
        customerName: row.customerName,
        bills: row.bills,
        outstanding: Number(row.outstanding.toFixed(2)),
        daysLabel: row.oldestOutstandingSale ? customerOutstandingAging(row.oldestOutstandingSale).label : "-"
      }))
      .sort((a, b) => Number(b.outstanding || 0) - Number(a.outstanding || 0));
  }, [repOutstandingDetailRep, reportSales]);
  const repOutstandingSummary = useMemo(() => ({
    reps: repOutstandingRows.length,
    bills: repOutstandingRows.reduce((acc, row) => acc + Number(row.bills || 0), 0),
    customers: repOutstandingRows.reduce((acc, row) => acc + Number(row.customers || 0), 0),
    outstanding: Number(repOutstandingRows.reduce((acc, row) => acc + Number(row.outstanding || 0), 0).toFixed(2))
  }), [repOutstandingRows]);
  const sortedRepOutstandingRows = useMemo(
    () => sortRows(repOutstandingRows, "repOutstanding", "outstanding", {
      rep: (row) => String(row.rep || ""),
      customers: (row) => Number(row.customers || 0),
      bills: (row) => Number(row.bills || 0),
      outstanding: (row) => Number(row.outstanding || 0)
    }),
    [repOutstandingRows, tableSort]
  );

  const loadingSummaryByLorry = useMemo(
    () => ORDER_LORRIES.reduce((acc, lorryName) => {
      const rows = loadingRowsByLorry[lorryName] || [];
      acc[lorryName] = {
        orderedQty: rows.reduce((sum, row) => sum + Number(row.orderedQty || 0), 0),
        orderedValue: rows.reduce((sum, row) => sum + Number(row.orderedValue || 0), 0),
        orderedBundles: rows.reduce((sum, row) => sum + Number(row.bundles || 0), 0),
        orderedSingles: rows.reduce((sum, row) => sum + Number(row.balance || 0), 0),
        deliveredQty: rows.reduce((sum, row) => sum + Number(row.deliveredQty || 0), 0),
        deliveredValue: rows.reduce((sum, row) => sum + Number(row.deliveredValue || 0), 0),
        deliveredBundles: rows.reduce((sum, row) => sum + Number(row.bundleSize ? Math.floor(Number(row.deliveredQty || 0) / row.bundleSize) : 0), 0),
        deliveredSingles: rows.reduce((sum, row) => sum + Number(row.bundleSize ? Number(row.deliveredQty || 0) % row.bundleSize : Number(row.deliveredQty || 0)), 0),
        loadedRows: rows.reduce((sum, row) => sum + (row.loaded ? 1 : 0), 0)
      };
      return acc;
    }, {}),
    [loadingRowsByLorry]
  );

  const deliveryRows = useMemo(() => {
    const rows = (state.sales || [])
      .filter((sale) => inDateTimeRange(sale.createdAt, deliveryDateFrom, deliveryDateTo, deliveryTimeFrom, deliveryTimeTo))
      .filter((sale) => (deliveryLorry === "all" ? true : sale.lorry === deliveryLorry))
      .map((sale) => {
        const undeliveredQty = (sale.deliveryAdjustments || []).reduce(
          (acc, adj) => acc + (adj.lines || []).reduce((lineAcc, line) => lineAcc + Number(line.quantity || 0), 0),
          0
        );
        const soldQty = (sale.lines || []).reduce((acc, line) => acc + Number(line.quantity || 0), 0);
        return {
          sale,
          id: sale.id,
          when: new Date(sale.createdAt).toLocaleString(),
          rep: sale.cashier || "-",
          lorry: sale.lorry || "-",
          total: saleNetTotal(sale),
          soldQty,
          undeliveredQty,
          confirmed: Boolean(sale.deliveryConfirmedAt)
        };
      });
    return rows.sort((a, b) => new Date(b.sale.createdAt).getTime() - new Date(a.sale.createdAt).getTime());
  }, [state.sales, deliveryDateFrom, deliveryDateTo, deliveryTimeFrom, deliveryTimeTo, deliveryLorry]);
  const sortedDeliveryRows = useMemo(
    () => sortRows(deliveryRows, "deliveries", "when", {
      id: (row) => Number(row.id || 0),
      when: (row) => new Date(row.sale?.createdAt || 0).getTime(),
      rep: (row) => String(row.rep || ""),
      lorry: (row) => String(row.lorry || ""),
      total: (row) => Number(row.total || 0),
      status: (row) => row.confirmed ? 1 : 0
    }),
    [deliveryRows, tableSort]
  );
  const notDeliveredRows = useMemo(() => {
    const rows = [];
    for (const sale of (state.sales || [])) {
      if (deliveryLorry !== "all" && sale.lorry !== deliveryLorry) continue;
      for (const adjustment of (sale.deliveryAdjustments || [])) {
        const adjustmentAt = adjustment?.createdAt || sale.deliveryConfirmedAt || sale.createdAt;
        if (!inDateTimeRange(adjustmentAt, deliveryDateFrom, deliveryDateTo, deliveryTimeFrom, deliveryTimeTo)) continue;
        for (const line of (adjustment.lines || [])) {
          const qty = Number(line.quantity || 0);
          if (qty <= 0) continue;
          const matchedSaleLine = (sale.lines || []).find((saleLine) => String(saleLine.productId || "") === String(line.productId || ""));
          const unitPrice = Number(matchedSaleLine?.price || matchedSaleLine?.basePrice || 0);
          rows.push({
            key: `${sale.id}-${line.productId}-${adjustmentAt}`,
            saleId: sale.id || "-",
            when: adjustmentAt ? new Date(adjustmentAt).toLocaleString() : "-",
            rep: sale.cashier || "-",
            lorry: sale.lorry || "-",
            customer: sale.customerName || "Walk-in",
            item: line.name || matchedSaleLine?.name || line.productId || "-",
            qty,
            value: Number((unitPrice * qty).toFixed(2)),
            createdAtTs: new Date(adjustmentAt || 0).getTime()
          });
        }
      }
    }
    return rows.sort((a, b) => Number(b.createdAtTs || 0) - Number(a.createdAtTs || 0));
  }, [state.sales, deliveryLorry, deliveryDateFrom, deliveryDateTo, deliveryTimeFrom, deliveryTimeTo]);
  const notDeliveredItemRows = useMemo(() => {
    const map = new Map();
    for (const row of notDeliveredRows) {
      const key = String(row.item || "-").trim() || "-";
      map.set(key, Number(map.get(key) || 0) + Number(row.qty || 0));
    }
    return Array.from(map.entries())
      .map(([item, qty]) => ({ item, qty: Number(qty || 0) }))
      .sort((a, b) => String(a.item || "").localeCompare(String(b.item || "")));
  }, [notDeliveredRows]);

  const deliveryReportSales = useMemo(
    () => (state.sales || [])
      .filter((sale) => inDateRange(sale.createdAt, deliveryReportDateFrom, deliveryReportDateTo))
      .filter((sale) => (deliveryLorry === "all" ? true : sale.lorry === deliveryLorry)),
    [state.sales, deliveryReportDateFrom, deliveryReportDateTo, deliveryLorry]
  );

  const deliveredItemRows = useMemo(() => {
    const sales = deliveryReportSales.filter((sale) => Boolean(sale.deliveryConfirmedAt));
    const map = new Map();
    for (const sale of sales) {
      const undeliveredByProduct = new Map();
      for (const adj of (sale.deliveryAdjustments || [])) {
        for (const line of (adj.lines || [])) {
          undeliveredByProduct.set(line.productId, (undeliveredByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
        }
      }
      for (const line of (sale.lines || [])) {
        const lineState = effectiveSaleLineState(sale, line, {
          returnedByProduct: saleReturnedQtyByProduct(sale, state.returns || []),
          undeliveredByProduct
        });
        if (lineState.effectiveQty <= 0) continue;
        const key = line.productId || line.name;
        const current = map.get(key) || {
          key,
          item: line.name || productInfoById.get(line.productId)?.name || "Unknown",
          sku: productInfoById.get(line.productId)?.sku || "-",
          qty: 0,
          value: 0
        };
        current.qty += lineState.effectiveQty;
        current.value += lineState.effectiveRevenue;
        map.set(key, current);
      }
    }
    return [...map.values()].sort((a, b) => b.qty - a.qty);
  }, [deliveryReportSales, productInfoById]);

  const deliveredTotals = useMemo(() => ({
    qty: deliveredItemRows.reduce((acc, row) => acc + Number(row.qty || 0), 0),
    value: Number(deliveredItemRows.reduce((acc, row) => acc + Number(row.value || 0), 0).toFixed(2))
  }), [deliveredItemRows]);
  const sortedDeliveredItemRows = useMemo(
    () => sortRows(deliveredItemRows, "deliveredItems", "qty", {
      item: (row) => String(row.item || ""),
      sku: (row) => String(row.sku || ""),
      qty: (row) => Number(row.qty || 0),
      value: (row) => Number(row.value || 0)
    }),
    [deliveredItemRows, tableSort]
  );

  const soldTotals = useMemo(() => ({
    qty: deliveryReportSales.reduce(
      (acc, sale) => acc + (sale.lines || []).reduce((lineAcc, line) => lineAcc + Number(line.quantity || 0), 0),
      0
    ),
    value: Number(deliveryReportSales.reduce((acc, sale) => acc + saleNetTotal(sale), 0).toFixed(2))
  }), [deliveryReportSales]);

  const reportDeliverySales = useMemo(
    () => (state.sales || [])
      .filter((sale) => inDateRange(sale.createdAt, reportDeliveryDateFrom, reportDeliveryDateTo))
      .filter((sale) => (reportDeliveryLorry === "all" ? true : sale.lorry === reportDeliveryLorry)),
    [state.sales, reportDeliveryDateFrom, reportDeliveryDateTo, reportDeliveryLorry]
  );

  const reportDeliveryRows = useMemo(() => {
    const rows = reportDeliverySales.map((sale) => {
      const soldQty = (sale.lines || []).reduce((acc, line) => acc + Number(line.quantity || 0), 0);
      const isConfirmed = Boolean(sale.deliveryConfirmedAt);
      const undeliveredByProduct = new Map();
      if (isConfirmed) {
        for (const adj of (sale.deliveryAdjustments || [])) {
          for (const line of (adj.lines || [])) {
            undeliveredByProduct.set(line.productId, (undeliveredByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
          }
        }
      }
      let undeliveredQty = 0;
      let deliveredQty = 0;
      let deliveredValue = 0;
      for (const line of (sale.lines || [])) {
        const lineState = isConfirmed
          ? effectiveSaleLineState(sale, line, {
            returnedByProduct: saleReturnedQtyByProduct(sale, state.returns || []),
            undeliveredByProduct
          })
          : { undeliveredQty: 0, effectiveQty: 0, effectiveRevenue: 0 };
        undeliveredQty += Number(lineState.undeliveredQty || 0);
        deliveredQty += Number(lineState.effectiveQty || 0);
        deliveredValue += Number(lineState.effectiveRevenue || 0);
      }
      return {
        id: sale.id,
        date: sale.createdAt ? new Date(sale.createdAt).toLocaleDateString() : "-",
        rep: sale.cashier || "-",
        lorry: sale.lorry || "-",
        status: isConfirmed ? "Confirmed" : "Pending",
        soldQty,
        undeliveredQty,
        deliveredQty,
        deliveredValue: Number(deliveredValue.toFixed(2))
      };
    });
    return rows.sort((a, b) => Number(b.id) - Number(a.id));
  }, [reportDeliverySales]);

  const reportDeliverySummary = useMemo(() => {
    const totalBills = reportDeliveryRows.length;
    const confirmedBills = reportDeliveryRows.filter((row) => row.status === "Confirmed").length;
    const pendingBills = totalBills - confirmedBills;
    const soldQtyTotal = reportDeliveryRows.reduce((acc, row) => acc + Number(row.soldQty || 0), 0);
    const undeliveredQtyTotal = reportDeliveryRows.reduce((acc, row) => acc + Number(row.undeliveredQty || 0), 0);
    const deliveredQtyTotal = reportDeliveryRows.reduce((acc, row) => acc + Number(row.deliveredQty || 0), 0);
    const deliveredValueTotal = Number(reportDeliveryRows.reduce((acc, row) => acc + Number(row.deliveredValue || 0), 0).toFixed(2));
    const deliveryRate = soldQtyTotal > 0 ? Number(((deliveredQtyTotal / soldQtyTotal) * 100).toFixed(1)) : 0;
    return {
      totalBills,
      confirmedBills,
      pendingBills,
      soldQtyTotal,
      undeliveredQtyTotal,
      deliveredQtyTotal,
      deliveredValueTotal,
      deliveryRate
    };
  }, [reportDeliveryRows]);
  const sortedReportDeliveryRows = useMemo(
    () => sortRows(reportDeliveryRows, "deliveryReport", "id", {
      id: (row) => Number(row.id || 0),
      date: (row) => new Date(row.date || 0).getTime(),
      rep: (row) => String(row.rep || ""),
      lorry: (row) => String(row.lorry || ""),
      status: (row) => String(row.status || ""),
      soldQty: (row) => Number(row.soldQty || 0),
      undeliveredQty: (row) => Number(row.undeliveredQty || 0),
      deliveredQty: (row) => Number(row.deliveredQty || 0),
      deliveredValue: (row) => Number(row.deliveredValue || 0)
    }),
    [reportDeliveryRows, tableSort]
  );

  const viewedSale = useMemo(
    () => (state.sales || []).find((sale) => String(sale.id) === String(viewSaleId)) || null,
    [state.sales, viewSaleId]
  );
  const viewedSaleReturnByProduct = useMemo(() => {
    const map = new Map();
    if (!viewedSale) return map;
    for (const ret of (state.returns || [])) {
      if (String(ret.saleId) !== String(viewedSale.id)) continue;
      for (const line of (ret.lines || [])) {
        const key = String(line.productId || "");
        if (!key) continue;
        const current = map.get(key) || { qty: 0, amount: 0 };
        current.qty += Number(line.quantity || 0);
        current.amount += Number(line.returnAmount || 0);
        map.set(key, current);
      }
    }
    return map;
  }, [state.returns, viewedSale]);
  const viewedSaleUndeliveredByProduct = useMemo(() => {
    const map = new Map();
    if (!viewedSale) return map;
    for (const adjustment of (viewedSale.deliveryAdjustments || [])) {
      for (const line of (adjustment.lines || [])) {
        const key = String(line.productId || "");
        if (!key) continue;
        map.set(key, Number(map.get(key) || 0) + Number(line.quantity || 0));
      }
    }
    return map;
  }, [viewedSale]);
  const viewedSaleReturnedAmount = useMemo(
    () => Number((viewedSale?.returnedAmount || 0).toFixed(2)),
    [viewedSale]
  );
  const viewedSaleNetAmount = useMemo(
    () => saleNetTotal(viewedSale),
    [viewedSale]
  );
  const viewedSalePaymentDisplay = useMemo(
    () => saleDisplayPaymentInfo(viewedSale),
    [viewedSale]
  );

  const deliverySale = useMemo(
    () => (state.sales || []).find((sale) => String(sale.id) === String(deliverySaleId)) || null,
    [state.sales, deliverySaleId]
  );
  const deliveryPaymentRows = useMemo(
    () => salePayments(deliverySale),
    [deliverySale]
  );
  const deliveryPaidSoFar = useMemo(
    () => Number(deliveryPaymentRows.reduce((acc, payment) => acc + Number(payment.amount || 0), 0).toFixed(2)),
    [deliveryPaymentRows]
  );
  const deliveryDraftCash = useMemo(
    () => Math.max(0, Number(deliveryCashReceived || 0) || 0),
    [deliveryCashReceived]
  );
  const deliveryDraftCheque = useMemo(
    () => Math.max(0, Number(deliveryChequeAmount || 0) || 0),
    [deliveryChequeAmount]
  );
  const deliveryDraftSettlement = useMemo(
    () => Number((deliveryDraftCash + deliveryDraftCheque).toFixed(2)),
    [deliveryDraftCash, deliveryDraftCheque]
  );
  const deliveryUndeliveredAmount = useMemo(
    () => deliveryAdjustmentAmount(deliverySale),
    [deliverySale]
  );
  const deliveryUndeliveredAmountWithDraft = useMemo(
    () => deliveryAdjustmentAmount(deliverySale, deliveryDraft),
    [deliverySale, deliveryDraft]
  );
  const deliveryRemaining = useMemo(
    () => Math.max(0, Number((Number(deliverySale?.total || 0) - Number(deliverySale?.returnedAmount || 0) - deliveryUndeliveredAmount - deliveryPaidSoFar).toFixed(2))),
    [deliverySale?.total, deliverySale?.returnedAmount, deliveryUndeliveredAmount, deliveryPaidSoFar]
  );
  const deliveryRemainingAfterDraft = useMemo(
    () => Math.max(0, Number((Number(deliverySale?.total || 0) - Number(deliverySale?.returnedAmount || 0) - deliveryUndeliveredAmountWithDraft - deliveryPaidSoFar - deliveryDraftSettlement).toFixed(2))),
    [deliverySale?.total, deliverySale?.returnedAmount, deliveryUndeliveredAmountWithDraft, deliveryPaidSoFar, deliveryDraftSettlement]
  );
  const deliverySettlementLimit = useMemo(() => {
    const extraUndelivered = Math.max(0, Number((deliveryUndeliveredAmountWithDraft - deliveryUndeliveredAmount).toFixed(2)));
    return Math.max(0, Number((deliveryRemaining - extraUndelivered).toFixed(2)));
  }, [deliveryRemaining, deliveryUndeliveredAmountWithDraft, deliveryUndeliveredAmount]);

  const openAdminSaleEdit = (sale) => {
    const hasDeliveryProcessing = Boolean(sale?.deliveryConfirmedAt) || Boolean((sale?.deliveryAdjustments || []).length);
    const hasReturns = (state.returns || []).some((ret) => String(ret.saleId) === String(sale?.id));
    if (hasDeliveryProcessing) {
      setNotice("This bill cannot be edited after delivery processing has started.");
      return;
    }
    if (hasReturns) {
      setNotice("This bill cannot be edited after returns have been submitted.");
      return;
    }
    setEditingAdminSaleId(sale.id);
    setAdminSaleEditLines((sale.lines || []).map((line) => ({
      productId: line.productId,
      name: line.name,
      quantity: Number(line.quantity || 0)
    })));
    setAdminSaleEditError("");
  };

  const saveAdminSaleEdit = async () => {
    try {
      const lines = adminSaleEditLines
        .map((line) => ({ ...line, quantity: Number(line.quantity || 0) }))
        .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
      if (!editingAdminSaleId || !lines.length) {
        setAdminSaleEditError("Keep at least one item in bill.");
        return;
      }
      setSavingAdminSaleEdit(true);
      setAdminSaleEditError("");
      await patchSale(editingAdminSaleId, { lines });
      setEditingAdminSaleId("");
      setAdminSaleEditLines([]);
      setNotice("Sale updated.");
    } catch (error) {
      setAdminSaleEditError(error.message);
    } finally {
      setSavingAdminSaleEdit(false);
    }
  };

  const deleteAdminSale = async (sale) => {
    try {
      const hasDeliveryProcessing = Boolean(sale?.deliveryConfirmedAt) || Boolean((sale?.deliveryAdjustments || []).length);
      if (hasDeliveryProcessing) {
        setNotice("This bill cannot be deleted after delivery processing has started.");
        return;
      }
      const ok = await requestConfirm({
        title: "Delete Sale",
        message: `Are you sure want to delete sale #${sale.id}? This will restore stock and remove linked returns.`,
        confirmLabel: "Delete",
        tone: "danger"
      });
      if (!ok) return;
      setDeletingSaleId(String(sale.id));
      await deleteSale(sale.id);
      onSaleDeleted?.(sale.id);
      setNotice(`Sale #${sale.id} deleted.`);
      if (editingAdminSaleId && String(editingAdminSaleId) === String(sale.id)) {
        setEditingAdminSaleId("");
        setAdminSaleEditLines([]);
      }
    } catch (error) {
      setNotice(error.message);
    } finally {
      setDeletingSaleId("");
    }
  };

  const printAdminSaleReceipt = (sale) => {
    const printSale = sale || viewedSale;
    if (!printSale) return;
    const returnByProduct = new Map();
    for (const ret of (state.returns || [])) {
      if (String(ret.saleId) !== String(printSale.id)) continue;
      for (const line of (ret.lines || [])) {
        const key = String(line.productId || "");
        if (!key) continue;
        const current = returnByProduct.get(key) || { qty: 0, amount: 0 };
        current.qty += Number(line.quantity || 0);
        current.amount += Number(line.returnAmount || 0);
        returnByProduct.set(key, current);
      }
    }
    const undeliveredByProduct = new Map();
    for (const adjustment of (printSale.deliveryAdjustments || [])) {
      for (const line of (adjustment.lines || [])) {
        const key = String(line.productId || "");
        if (!key) continue;
        undeliveredByProduct.set(key, Number(undeliveredByProduct.get(key) || 0) + Number(line.quantity || 0));
      }
    }
    openSaleReceiptPrint({
      sale: printSale,
      customers: state.customers || [],
      products: state.products || [],
      returnByProduct,
      undeliveredByProduct,
      returnedAmountOverride: Number(printSale?.returnedAmount || 0),
      totalOverride: saleNetTotal(printSale),
      onPopupBlocked: () => setNotice("Allow popups to print receipt.")
    });
  };

  const printLoadingBreakdown = ({ lorry, rows, summary }) => {
    const printWindow = window.open("", "_blank", "width=1100,height=900");
    if (!printWindow) {
      setNotice("Allow popups to print loading breakdown.");
      return;
    }
    const fromLabel = loadingDateFrom ? `${loadingDateFrom}${loadingTimeFrom ? ` ${loadingTimeFrom}` : ""}` : "-";
    const toLabel = loadingDateTo ? `${loadingDateTo}${loadingTimeTo ? ` ${loadingTimeTo}` : ""}` : "-";
    const dateRangeLabel = `${fromLabel} to ${toLabel}`;
    const rowsHtml = (rows || []).length ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(String(row.sku || "-"))}</td>
        <td>${Number(row.orderedQty || 0)}</td>
        <td>${formatLkrValue(row.orderedValue || 0)}</td>
        <td>${Number(row.bundles || 0)}</td>
        <td>${Number(row.balance || 0)}</td>
        <td>${Number(row.deliveredQty || 0)}</td>
        <td>${formatLkrValue(row.deliveredValue || 0)}</td>
      </tr>
    `).join("") : `<tr><td colspan="7">No loading records for ${escapeHtml(lorry)} in selected range.</td></tr>`;
    const printHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(lorry)} Loading Breakdown</title>
  <style>
    @page { size: A4 portrait; margin: 10mm; }
    body { margin: 0; background: #fff; font-family: "Segoe UI", Arial, sans-serif; color: #122640; }
    .sheet { width: 100%; max-width: 190mm; margin: 0 auto; padding: 4mm; }
    .head { display: grid; grid-template-columns: 82px 1fr; gap: 14px; align-items: center; border: 1px solid #cdd9e8; border-radius: 18px; padding: 14px 16px; background: linear-gradient(135deg, #fbfdff 0%, #eef4fc 46%, #e2ecfa 100%); }
    .head img { width: 74px; height: 74px; object-fit: contain; }
    .head h1 { margin: 0; font-size: 24px; line-height: 1.05; }
    .head p { margin: 6px 0 0; color: #4e647d; font-size: 13px; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
    .kpis article { border: 1px solid #d2ddea; border-radius: 14px; padding: 10px 12px; background: #f7fbff; }
    .kpis span { display: block; color: #536980; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    .kpis strong { display: block; margin-top: 5px; font-size: 20px; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { border: 1px solid #afbdd0; padding: 8px 9px; font-size: 13px; }
    th { background: #e5edf8; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; }
    th:nth-child(n+2), td:nth-child(n+2) { text-align: center; }
    .footer { margin-top: 18px; display: flex; justify-content: space-between; gap: 16px; color: #5b6f86; font-size: 12px; }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="head">
      <img src="/sls-logo.svg" alt="SLS" />
      <div>
        <h1>${escapeHtml(lorry)} Loading Breakdown</h1>
        <p>SLS POS &bull; Date Range: ${escapeHtml(dateRangeLabel)}</p>
      </div>
    </div>
    <div class="kpis">
      <article><span>Ordered Qty</span><strong>${Number(summary?.orderedQty || 0)}</strong></article>
      <article><span>Ordered Value</span><strong>LKR ${formatLkrValue(summary?.orderedValue || 0)}</strong></article>
      <article><span>Delivered Qty</span><strong>${Number(summary?.deliveredQty || 0)}</strong></article>
      <article><span>Delivered Value</span><strong>LKR ${formatLkrValue(summary?.deliveredValue || 0)}</strong></article>
      <article><span>Ordered Bundles</span><strong>${Number(summary?.orderedBundles || 0)}</strong></article>
      <article><span>Ordered Singles</span><strong>${Number(summary?.orderedSingles || 0)}</strong></article>
      <article><span>Delivered Bundles</span><strong>${Number(summary?.deliveredBundles || 0)}</strong></article>
      <article><span>Delivered Singles</span><strong>${Number(summary?.deliveredSingles || 0)}</strong></article>
    </div>
    <table>
      <thead>
        <tr>
          <th>SKU</th>
          <th>Ord Qty</th>
          <th>Ord Value (LKR)</th>
          <th>Bundles</th>
          <th>Singles</th>
          <th>Del Qty</th>
          <th>Del Value (LKR)</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="footer">
      <div>Generated on ${escapeHtml(new Date().toLocaleString())}</div>
      <div>J&amp;Co. Software Solutions</div>
    </div>
  </div>
</body>
</html>`;
    printWindow.document.open();
    printWindow.document.write(printHtml);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
  };

  const printRepOutstandingCustomers = ({ rep, rows }) => {
    const printWindow = window.open("", "_blank", "width=980,height=900");
    if (!printWindow) {
      setNotice("Allow popups to print rep outstanding details.");
      return;
    }
    const generatedAt = new Date().toLocaleString();
    const totalBills = Number((rows || []).reduce((acc, row) => acc + Number(row.bills || 0), 0));
    const totalOutstanding = Number((rows || []).reduce((acc, row) => acc + Number(row.outstanding || 0), 0).toFixed(2));
    const bodyRows = (rows || []).length
      ? rows.map((row) => `
        <tr>
          <td>${escapeHtml(String(row.customerName || "-"))}</td>
          <td>${Number(row.bills || 0)}</td>
          <td>LKR ${formatLkrValue(row.outstanding || 0)}</td>
          <td>${escapeHtml(String(row.daysLabel || "-"))}</td>
        </tr>
      `).join("")
      : `<tr><td colspan="4">No outstanding customers for this rep in the selected range.</td></tr>`;
    const printHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(rep)} Customer Outstanding</title>
  <style>
    @page { size: A4 portrait; margin: 10mm; }
    body { margin: 0; background: #fff; font-family: "Segoe UI", Arial, sans-serif; color: #122640; }
    .sheet { width: 100%; max-width: 190mm; margin: 0 auto; padding: 4mm; }
    .head { display: grid; grid-template-columns: 82px 1fr; gap: 14px; align-items: center; border: 1px solid #cdd9e8; border-radius: 18px; padding: 14px 16px; background: linear-gradient(135deg, #fbfdff 0%, #eef4fc 46%, #e2ecfa 100%); }
    .head img { width: 74px; height: 74px; object-fit: contain; }
    .head h1 { margin: 0; font-size: 24px; line-height: 1.05; }
    .head p { margin: 6px 0 0; color: #4e647d; font-size: 13px; }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; }
    .summary article { border: 1px solid #d2ddea; border-radius: 14px; padding: 10px 12px; background: #f7fbff; }
    .summary span { display: block; color: #536980; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    .summary strong { display: block; margin-top: 5px; font-size: 20px; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { border: 1px solid #afbdd0; padding: 9px 10px; font-size: 13px; }
    th { background: #e5edf8; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; text-align: left; }
    th:nth-child(2), th:nth-child(3), td:nth-child(2), td:nth-child(3) { text-align: center; }
    .footer { margin-top: 18px; display: flex; justify-content: space-between; gap: 16px; color: #5b6f86; font-size: 12px; }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="head">
      <img src="/sls-logo.svg" alt="SLS" />
      <div>
        <h1>${escapeHtml(rep)} Customer Outstanding</h1>
        <p>Outstanding customer summary by rep</p>
      </div>
    </div>
    <div class="summary">
      <article><span>Customers</span><strong>${Number(rows?.length || 0)}</strong></article>
      <article><span>Bills</span><strong>${totalBills}</strong></article>
      <article><span>Outstanding</span><strong>LKR ${formatLkrValue(totalOutstanding)}</strong></article>
    </div>
    <table>
      <thead>
        <tr>
          <th>Customer</th>
          <th>Bills</th>
          <th>Outstanding (LKR)</th>
          <th>Days Left</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <div class="footer">
      <div>Generated on ${escapeHtml(generatedAt)}</div>
      <div>J&amp;Co. Software Solutions</div>
    </div>
  </div>
</body>
</html>`;
    printWindow.document.open();
    printWindow.document.write(printHtml);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
  };

  const printNotDeliveredReport = (rows) => {
    const printWindow = window.open("", "_blank", "width=1200,height=900");
    if (!printWindow) {
      setNotice("Allow popups to print not delivered report.");
      return;
    }
    const fromLabel = deliveryDateFrom ? `${deliveryDateFrom}${deliveryTimeFrom ? ` ${deliveryTimeFrom}` : ""}` : "-";
    const toLabel = deliveryDateTo ? `${deliveryDateTo}${deliveryTimeTo ? ` ${deliveryTimeTo}` : ""}` : "-";
    const rangeLabel = `${fromLabel} to ${toLabel}`;
    const lorryLabel = deliveryLorry === "all" ? "All Lorries" : deliveryLorry;
    const totalQty = Number((rows || []).reduce((sum, row) => sum + Number(row.qty || 0), 0));
    const totalValue = Number((notDeliveredRows || []).reduce((sum, row) => sum + Number(row.value || 0), 0).toFixed(2));
    const bodyRows = (rows || []).length
      ? rows.map((row) => `
        <tr>
          <td>${escapeHtml(String(row.item || "-"))}</td>
          <td>${Number(row.qty || 0)}</td>
        </tr>
      `).join("")
      : `<tr><td colspan="2">No not-delivered items found for the selected range.</td></tr>`;
    const printHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Not Delivered Report</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    body { margin: 0; background: #fff; font-family: "Segoe UI", Arial, sans-serif; color: #122640; }
    .sheet { width: 100%; margin: 0 auto; }
    .head { border: 1px solid #cdd9e8; border-radius: 16px; padding: 12px 14px; background: linear-gradient(135deg, #fbfdff 0%, #eef4fc 46%, #e2ecfa 100%); }
    .head h1 { margin: 0; font-size: 24px; line-height: 1.05; }
    .head p { margin: 6px 0 0; color: #4e647d; font-size: 13px; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
    .summary article { border: 1px solid #d2ddea; border-radius: 12px; padding: 8px 10px; background: #f7fbff; }
    .summary span { display: block; color: #536980; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    .summary strong { display: block; margin-top: 4px; font-size: 18px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #afbdd0; padding: 8px 9px; font-size: 12px; }
    th { background: #e5edf8; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; text-align: left; }
    td:nth-child(2), th:nth-child(2) { text-align: right; }
    .footer { margin-top: 14px; display: flex; justify-content: space-between; gap: 12px; color: #5b6f86; font-size: 12px; }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="head">
      <h1>Not Delivered Report</h1>
      <p>Date/Time Range: ${escapeHtml(rangeLabel)} | Lorry: ${escapeHtml(lorryLabel)}</p>
    </div>
    <div class="summary">
      <article><span>Rows</span><strong>${Number(rows?.length || 0)}</strong></article>
      <article><span>ND Qty</span><strong>${totalQty}</strong></article>
      <article><span>ND Value</span><strong>LKR ${formatLkrValue(totalValue)}</strong></article>
      <article><span>Generated</span><strong>${escapeHtml(new Date().toLocaleString())}</strong></article>
    </div>
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>ND Qty</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <div class="footer">
      <div>SLS POS</div>
      <div>J&amp;Co. Software Solutions</div>
    </div>
  </div>
</body>
</html>`;
    printWindow.document.open();
    printWindow.document.write(printHtml);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
  };

  const openDeliveryModal = (sale) => {
    setDeliverySaleId(String(sale.id));
    setDeliveryDraft({});
    setDeliveryCashReceived("");
    setDeliveryChequeAmount("");
    setDeliveryChequeNo("");
    setDeliveryChequeDate("");
    setDeliveryChequeBank("");
    setDeliveryError("");
  };

  const onDeliveryDraftChange = (productId, value) => {
    setDeliveryDraft((current) => ({ ...current, [productId]: value }));
  };

  const saveDeliveryAdjust = async () => {
    try {
      if (!deliverySale) {
        setDeliveryError("Sale not found.");
        return;
      }
      const lines = (deliverySale.lines || [])
        .map((line) => ({
          productId: line.productId,
          quantity: Number(deliveryDraft[line.productId] || 0)
        }))
        .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);
      const cash = Number(deliveryCashReceived || 0);
      const cheque = Number(deliveryChequeAmount || 0);
      if (!Number.isFinite(cash) || cash < 0) {
        setDeliveryError("Cash received must be 0 or more.");
        return;
      }
      if (!Number.isFinite(cheque) || cheque < 0) {
        setDeliveryError("Cheque amount must be 0 or more.");
        return;
      }
      if ((cash + cheque) > Number((deliverySettlementLimit + 0.01).toFixed(2))) {
        setDeliveryError(`Cash and cheque total cannot exceed remaining balance (${currency(deliverySettlementLimit)}).`);
        return;
      }
      if (cheque > 0 && (!deliveryChequeNo.trim() || !deliveryChequeDate || !deliveryChequeBank.trim())) {
        setDeliveryError("Enter cheque number, date, and bank.");
        return;
      }
      setSavingDelivery(true);
      setDeliveryError("");
      await submitDeliveryAdjustment(deliverySale.id, {
        lines,
        markConfirmed: true,
        cashReceived: cash,
        chequeAmount: cheque,
        chequeNo: deliveryChequeNo.trim(),
        chequeDate: deliveryChequeDate,
        chequeBank: deliveryChequeBank.trim()
      });
      setDeliverySaleId("");
      setDeliveryDraft({});
      setDeliveryCashReceived("");
      setDeliveryChequeAmount("");
      setDeliveryChequeNo("");
      setDeliveryChequeDate("");
      setDeliveryChequeBank("");
      setNotice(`Delivery confirmed for sale #${deliverySale.id}.`);
    } catch (error) {
      setDeliveryError(error.message);
    } finally {
      setSavingDelivery(false);
    }
  };

  const openCustomerAdd = () => {
    setCustomerForm({ id: "", name: "", phone: "", address: "", openingOutstanding: "", creditLimit: "", discountLimit: "", bundleDiscountLimit: "", outstandingAdjustment: "", outstandingAdjustmentReason: "" });
    setShowCustomerForm(true);
  };

  const openCustomerEdit = () => {
    const first = (state.customers || [])[0];
    if (!first) {
      setNotice("No customer to edit.");
      return;
    }
    setCustomerForm({
      id: first.id,
      name: first.name,
      phone: first.phone || "",
      address: first.address || "",
      openingOutstanding: first.openingOutstanding ? String(first.openingOutstanding) : "",
      creditLimit: first.creditLimit ? String(first.creditLimit) : "",
      discountLimit: first.discountLimit ? String(first.discountLimit) : "",
      bundleDiscountLimit: first.bundleDiscountLimit ? String(first.bundleDiscountLimit) : "",
      outstandingAdjustment: first.outstandingAdjustment ? String(first.outstandingAdjustment) : "",
      outstandingAdjustmentReason: first.outstandingAdjustmentReason || ""
    });
    setShowCustomerForm(true);
  };

  const openCustomerEditByRow = (row) => {
    if (!row) return;
    const matched = (state.customers || []).find((item) => String(item.name || "").trim().toLowerCase() === String(row.name || "").trim().toLowerCase());
    if (!matched) {
      setNotice("Selected customer was not found in saved list.");
      return;
    }
    setCustomerForm({
      id: matched.id,
      name: matched.name || row.name || "",
      phone: matched.phone || row.phone || "",
      address: matched.address || row.address || "",
      openingOutstanding: matched.openingOutstanding ? String(matched.openingOutstanding) : "",
      creditLimit: matched.creditLimit ? String(matched.creditLimit) : "",
      discountLimit: matched.discountLimit ? String(matched.discountLimit) : "",
      bundleDiscountLimit: matched.bundleDiscountLimit ? String(matched.bundleDiscountLimit) : "",
      outstandingAdjustment: matched.outstandingAdjustment ? String(matched.outstandingAdjustment) : "",
      outstandingAdjustmentReason: matched.outstandingAdjustmentReason || ""
    });
    setShowCustomerForm(true);
  };

  const saveCustomer = () => {
    if (!customerForm.name.trim()) {
      setNotice("Customer name is required.");
      return;
    }
    if (isManager && !managerFullAccessEnabled) {
      setNotice("Manager limited access cannot edit customers.");
      return;
    }
    const openingOutstanding = Number(customerForm.openingOutstanding || 0);
    const creditLimit = Number(customerForm.creditLimit || 0);
    const discountLimit = Number(customerForm.discountLimit || 0);
    const bundleDiscountLimit = Number(customerForm.bundleDiscountLimit || 0);
    const outstandingAdjustment = Number(customerForm.outstandingAdjustment || 0);
    const outstandingAdjustmentReason = String(customerForm.outstandingAdjustmentReason || "").trim();
    if (!Number.isFinite(openingOutstanding) || openingOutstanding < 0) {
      setNotice("Opening outstanding must be 0 or more.");
      return;
    }
    if (!Number.isFinite(creditLimit) || creditLimit < 0) {
      setNotice("Credit limit must be 0 or more.");
      return;
    }
    if (!Number.isFinite(discountLimit) || discountLimit < 0) {
      setNotice("Discount limit must be 0 or more.");
      return;
    }
    if (!Number.isFinite(bundleDiscountLimit) || bundleDiscountLimit < 0) {
      setNotice("Bundle discount limit must be 0 or more.");
      return;
    }
    if (!Number.isFinite(outstandingAdjustment) || outstandingAdjustment < 0) {
      setNotice("Outstanding adjustment must be 0 or more.");
      return;
    }
    const payload = {
      name: customerForm.name.trim(),
      phone: customerForm.phone,
      address: customerForm.address
    };
    if (canManageCustomerOpeningOutstanding) {
      payload.openingOutstanding = Number(openingOutstanding.toFixed(2));
    }
    if (canManageCustomerLimits) {
      payload.creditLimit = Number(creditLimit.toFixed(2));
      payload.discountLimit = Number(discountLimit.toFixed(2));
      payload.bundleDiscountLimit = Number(bundleDiscountLimit.toFixed(2));
    }
    if (canManageOutstandingAdjustment) {
      payload.outstandingAdjustment = Number(outstandingAdjustment.toFixed(2));
      payload.outstandingAdjustmentReason = outstandingAdjustmentReason;
    }
    const action = customerForm.id ? updateCustomer(customerForm.id, payload) : createCustomer(payload);
    action
      .then(() => {
        setShowCustomerForm(false);
        setNotice("Customer saved.");
      })
      .catch((error) => setNotice(error.message));
  };

  const openStaffAdd = () => {
    if (!canManageUsers) {
      setNotice("Manager access cannot create or edit users.");
      return;
    }
    setStaffForm({ id: "", authUserId: "", name: "", role: "", phone: "", username: "", password: "", authRole: "cashier" });
    setShowStaffForm(true);
  };

  const openStaffEditByRow = (row) => {
    if (!canManageUsers) {
      setNotice("Manager access cannot create or edit users.");
      return;
    }
    if (!row) return;
    const matched = (state.staff || []).find((item) => String(item.id || "") === String(row.staffId || ""))
      || (state.staff || []).find(
        (item) => String(item.name || "").trim().toLowerCase() === String(row.name || "").trim().toLowerCase()
      );
    const matchedAuth = (authUsers || []).find((item) => String(item.id || "") === String(row.authUserId || ""))
      || (authUsers || []).find(
        (item) => String(item.username || "").trim().toLowerCase() === String(row.username || "").trim().toLowerCase()
      )
      || (authUsers || []).find(
        (item) => String(item.name || "").trim().toLowerCase() === String(row.name || "").trim().toLowerCase()
      );
    if (!matched && !matchedAuth) {
      setNotice("Selected user was not found.");
      return;
    }
    setStaffForm({
      id: matched?.id || "",
      authUserId: matchedAuth?.id || "",
      name: matchedAuth?.name || matched?.name || row.name || "",
      role: matched?.role || row.role || "",
      phone: matched?.phone || row.phone || "",
      username: matchedAuth?.username || row.username || "",
      password: "",
      authRole: matchedAuth?.role || row.authRole || "cashier"
    });
    setShowStaffForm(true);
  };

  const saveStaff = () => {
    if (!canManageUsers) {
      setNotice("Manager access cannot create or edit users.");
      return;
    }
    if (!staffForm.name.trim()) {
      setNotice("Staff name is required.");
      return;
    }
    if (!staffForm.id) {
      if (!String(staffForm.username || "").trim()) {
        setNotice("Username is required for new staff.");
        return;
      }
      if (!String(staffForm.password || "").trim()) {
        setNotice("Password is required for new staff.");
        return;
      }
    }
    const payload = { name: staffForm.name.trim(), role: staffForm.role, phone: staffForm.phone };
    const isEdit = Boolean(staffForm.id || staffForm.authUserId);
    const actions = [];
    if (isEdit) {
      if (staffForm.id) {
        actions.push(updateStaff(staffForm.id, payload));
      } else if (String(staffForm.phone || "").trim() || String(staffForm.role || "").trim()) {
        actions.push(createStaff(payload));
      }
      if (staffForm.authUserId) {
        actions.push(updateAuthUser(staffForm.authUserId, {
          name: staffForm.name.trim(),
          role: staffForm.authRole || "cashier",
          password: String(staffForm.password || "").trim() || undefined
        }));
      }
    } else {
      actions.push(createStaff(payload));
      actions.push(createAuthUser({
        name: staffForm.name.trim(),
        username: String(staffForm.username || "").trim(),
        password: String(staffForm.password || ""),
        role: staffForm.authRole || "cashier"
      }));
    }
    const action = Promise.all(actions);
    action
      .then(() => {
        setShowStaffForm(false);
        if (canManageUsers) {
          fetchAuthUsers().then((rows) => setAuthUsers(Array.isArray(rows) ? rows : [])).catch(() => {});
        }
        setNotice(isEdit ? "User saved." : "User created.");
      })
      .catch((error) => setNotice(error.message));
  };

  const deleteUserByRow = async (row) => {
    if (!canManageUsers) {
      setNotice("Manager access cannot create or edit users.");
      return;
    }
    if (!row?.authUserId && !row?.staffId) {
      setNotice("Selected user cannot be deleted.");
      return;
    }
    if (String(row.authUserId || "") && String(row.authUserId || "") === String(user?.id || "")) {
      setNotice("You cannot delete your own login.");
      return;
    }
    const accepted = await requestConfirm({
      title: "Delete User",
      message: `Delete ${row.name || "this user"}? This removes the login and linked staff profile, but keeps historical sales records.`,
      confirmLabel: "Delete User",
      cancelLabel: "Cancel",
      tone: "danger"
    });
    if (!accepted) return;

    const actions = [];
    if (row.authUserId) {
      actions.push(deleteAuthUser(row.authUserId));
    }
    if (row.staffId) {
      actions.push(deleteStaff(row.staffId));
    }

    try {
      await Promise.all(actions);
      if (canManageUsers) {
        fetchAuthUsers().then((rows) => setAuthUsers(Array.isArray(rows) ? rows : [])).catch(() => {});
      }
      setShowStaffForm(false);
      setNotice("User deleted.");
    } catch (error) {
      setNotice(error.message || "Unable to delete user.");
    }
  };

  const handleResetLorryCount = async () => {
    const accepted = await requestConfirm({
      title: "Reset Lorry Count",
      message: "Reset both lorry counts to 0 for new orders? This will not change stock, sales, deliveries, or loading reports.",
      confirmLabel: "Reset Count",
      cancelLabel: "Cancel",
      tone: "danger"
    });
    if (!accepted) return;
    try {
      setResettingLorryCount(true);
      await resetLorryCount();
      setNotice("Lorry count reset to 0 for new orders.");
    } catch (error) {
      setNotice(error.message || "Unable to reset lorry count.");
    } finally {
      setResettingLorryCount(false);
    }
  };

  const handleToggleLoadingRow = async (row) => {
    const markKey = String(row?.markKey || "").trim();
    if (!markKey) return;
    try {
      setLoadingMarkPendingKey(markKey);
      await setLoadingRowMark({ markKey, loaded: !row.loaded });
      setNotice(!row.loaded ? "Loading row marked as loaded." : "Loading row marked as not loaded.");
    } catch (error) {
      setNotice(error.message || "Unable to update loading row status.");
    } finally {
      setLoadingMarkPendingKey("");
    }
  };

  const handleManagerFullAccessToggle = async () => {
    if (isManager) return;
    try {
      setManagerAccessPending(true);
      await setManagerFullAccess({ enabled: !managerFullAccessEnabled });
      setNotice(!managerFullAccessEnabled ? "Manager full access enabled." : "Manager full access disabled.");
    } catch (error) {
      setNotice(error.message || "Unable to update manager full access.");
    } finally {
      setManagerAccessPending(false);
    }
  };

  const openStockAdd = () => {
    if (!canManageStock) {
      setNotice("Manager access cannot edit stock.");
      return;
    }
    setStockMode("add");
    setStockForm({ productId: "", quantity: "", stock: "", sku: "", invoicePrice: "", billingPrice: "", mrp: "" });
    setStockSearch("");
    setShowStockSuggestions(false);
    setNewStockItemForm({ sku: "", category: "General", billingPrice: "", invoicePrice: "", mrp: "" });
    setShowStockForm(true);
  };

  const openStockEdit = () => {
    if (!canManageStock) {
      setNotice("You do not have stock edit access.");
      return;
    }
    setStockMode("edit");
      setStockForm({
        productId: state.products[0]?.id || "",
        quantity: "",
        stock: state.products[0]?.stock || "",
        sku: state.products[0]?.sku || "",
        invoicePrice: String(state.products[0]?.invoicePrice ?? ""),
        billingPrice: String(state.products[0]?.billingPrice ?? state.products[0]?.price ?? ""),
        mrp: String(state.products[0]?.mrp ?? state.products[0]?.price ?? "")
      });
      setShowStockForm(true);
    };

  const openStockEditByRow = (row) => {
    if (!canManageStock) {
      setNotice("You do not have stock edit access.");
      return;
    }
    if (!row) return;
    const matched = (state.products || []).find((item) => item.id === row.id);
    if (!matched) {
      setNotice("Selected stock item was not found.");
      return;
    }
    setStockMode("edit");
      setStockForm({
        productId: matched.id,
        quantity: "",
        stock: String(matched.stock ?? ""),
        sku: matched.sku || "",
        invoicePrice: String(matched.invoicePrice ?? ""),
        billingPrice: String(matched.billingPrice ?? matched.price ?? ""),
        mrp: String(matched.mrp ?? matched.price ?? "")
      });
      setShowStockForm(true);
    };

  const onStockProductChange = (productId) => {
    const selected = state.products.find((item) => item.id === productId);
      setStockForm((current) => ({
        ...current,
        productId,
        sku: selected?.sku || "",
        invoicePrice: stockMode === "edit" ? String(selected?.invoicePrice ?? "") : current.invoicePrice,
        billingPrice: stockMode === "edit" ? String(selected?.billingPrice ?? selected?.price ?? "") : current.billingPrice,
        mrp: stockMode === "edit" ? String(selected?.mrp ?? selected?.price ?? "") : current.mrp,
        stock: stockMode === "edit" ? String(selected?.stock ?? "") : current.stock
      }));
  };

  const onStockSearchChange = (value) => {
    setStockSearch(value);
    setShowStockSuggestions(true);
    setStockForm((current) => ({ ...current, productId: "", sku: "" }));
  };

  const onSelectExistingStockItem = (product) => {
    setStockSearch(product.name);
    setStockForm((current) => ({
      ...current,
      productId: product.id,
      sku: product.sku
    }));
      setNewStockItemForm((current) => ({
        ...current,
        billingPrice: String(product.billingPrice ?? ""),
        invoicePrice: String(product.invoicePrice ?? ""),
        mrp: String(product.mrp ?? product.price ?? "")
      }));
    setShowStockSuggestions(false);
  };

  const exportStockReport = () => {
    try {
      const rows = (sortedStockRows || []).map((item) => ({
        sku: String(item.sku || ""),
        billingPrice: formatLkrValue(item.billingPrice ?? item.price ?? 0),
        mrp: formatLkrValue(item.mrp ?? item.price ?? 0),
        stock: Number(item.stock || 0)
      }));
      const header = ["SKU", "Billing Price (LKR)", "MRP (LKR)", "Stock"];
      const csvRows = [
        header.join(","),
        ...rows.map((row) => [
          `"${String(row.sku).replace(/"/g, '""')}"`,
          row.billingPrice,
          row.mrp,
          row.stock
        ].join(","))
      ];
      const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      const dateTag = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = `stock-report-${dateTag}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      setNotice("Stock report exported.");
    } catch (error) {
      setNotice(error.message || "Unable to export stock report.");
    }
  };

  const exportCustomerReport = () => {
    try {
      const rows = (sortedCustomerRows || []).map((row) => ({
        name: String(row.name || ""),
        phone: String(row.phone || ""),
        address: String(row.address || "")
      }));
      const header = ["Name", "Phone", "Address"];
      const csvRows = [
        header.join(","),
        ...rows.map((row) => [
          `"${row.name.replace(/"/g, '""')}"`,
          `"${row.phone.replace(/"/g, '""')}"`,
          `"${row.address.replace(/"/g, '""')}"`
        ].join(","))
      ];
      const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      const dateTag = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = `customers-${dateTag}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      setNotice("Customer report exported.");
    } catch (error) {
      setNotice(error.message || "Unable to export customer report.");
    }
  };

  const importCustomers = async (csvText) => {
    try {
      const lines = String(csvText || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (!lines.length) {
        setNotice("Paste or upload customer rows first.");
        return;
      }
      const parseCsvLine = (line) => {
        const parts = [];
        let current = "";
        let quoted = false;
        for (let i = 0; i < line.length; i += 1) {
          const char = line[i];
          if (char === '"') {
            if (quoted && line[i + 1] === '"') {
              current += '"';
              i += 1;
            } else {
              quoted = !quoted;
            }
          } else if (char === "," && !quoted) {
            parts.push(current.trim());
            current = "";
          } else {
            current += char;
          }
        }
        parts.push(current.trim());
        return parts.map((part) => part.replace(/^"(.*)"$/, "$1").trim());
      };
      const header = parseCsvLine(lines[0]).map((cell) => cell.toLowerCase());
      const nameIndex = header.indexOf("name");
      const phoneIndex = header.indexOf("phone");
      const addressIndex = header.indexOf("address");
      if (nameIndex < 0) {
        setNotice("Customer import requires at least: name,phone,address");
        return;
      }
      const rows = lines.slice(1).map(parseCsvLine).map((cols) => ({
        name: String(cols[nameIndex] || "").trim(),
        phone: String(cols[phoneIndex] || "").trim(),
        address: String(cols[addressIndex] || "").trim()
      })).filter((row) => row.name);
      if (!rows.length) {
        setNotice("No valid customer rows found. Use: name,phone,address");
        return;
      }
      const existingByName = new Map((state.customers || []).map((row) => [String(row.name || "").trim().toLowerCase(), row]));
      let created = 0;
      let updated = 0;
      for (const row of rows) {
        const matched = existingByName.get(row.name.toLowerCase());
        if (matched) {
          await updateCustomer(matched.id, row);
          updated += 1;
        } else {
          await createCustomer(row);
          created += 1;
        }
      }
      setNotice(`Imported ${updated} updates, created ${created} customers.`);
    } catch (error) {
      setNotice(error.message || "Unable to import customers.");
    }
  };

  const onCustomerImportFileSelected = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await importCustomers(text);
    event.target.value = "";
  };

  const saveStock = async () => {
    try {
        if (!canManageStock) {
          setNotice("You do not have stock edit access.");
          return;
        }
        const selected = state.products.find((item) => item.id === stockForm.productId);
        if (stockMode === "add") {
          const qty = Number(stockForm.quantity || 0);
          const billingPrice = Number(newStockItemForm.billingPrice);
          const invoicePrice = Number(newStockItemForm.invoicePrice || 0);
          const mrp = Number(newStockItemForm.mrp);
          if (Number.isNaN(qty) || qty <= 0) {
            setNotice("Enter a valid quantity.");
            return;
          }
          if (Number.isNaN(billingPrice) || billingPrice < 0 || Number.isNaN(invoicePrice) || invoicePrice < 0 || Number.isNaN(mrp) || mrp <= 0) {
            setNotice("Invoice Price, Billing Price and MRP are required.");
            return;
          }

          if (selected) {
            await patchProduct(selected.id, {
              stock: Number(selected.stock) + qty,
              invoicePrice,
              billingPrice,
              mrp,
              price: mrp
          });
          setNotice(`Stock added to ${selected.name}.`);
        } else {
          const name = stockSearch.trim();
          if (!name) {
            setNotice("Type item name.");
            return;
          }
          const generatedSkuBase = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "ITEM";
          const generatedSku = `${generatedSkuBase}${Math.floor(100 + Math.random() * 900)}`;
            await createProduct({
              name,
              sku: newStockItemForm.sku.trim() || generatedSku,
              category: newStockItemForm.category.trim() || "General",
              invoicePrice,
              billingPrice,
              mrp,
              price: mrp,
            stock: qty
          });
          setNotice(`New item created: ${name}.`);
        }
        } else {
          if (!selected) {
          setNotice("Select a valid product.");
          return;
          }
          await patchProduct(selected.id, {
            stock: Number(stockForm.stock || selected.stock),
            sku: String(stockForm.sku || selected.sku).trim(),
            invoicePrice: Number(stockForm.invoicePrice || selected.invoicePrice || 0),
            billingPrice: Number(stockForm.billingPrice || selected.billingPrice || selected.price || 0),
            mrp: Number(stockForm.mrp || selected.mrp || selected.price || 0),
            price: Number(stockForm.mrp || selected.mrp || selected.price || 0)
          });
          setNotice("Stock updated.");
      }
      setShowStockForm(false);
    } catch (error) {
      setNotice(error.message);
    }
  };

  const deleteStockProductById = async (product) => {
    try {
      if (!canManageStock) {
        setNotice("Manager access cannot edit stock.");
        return;
      }
      if (!product?.id) return;
      const ok = await requestConfirm({
        title: "Delete Product",
        message: `Are you sure want to delete ${product.name} (${product.sku})? This cannot be undone.`,
        confirmLabel: "Delete",
        tone: "danger"
      });
      if (!ok) return;
      setDeletingProduct(true);
      await deleteProduct(product.id);
      setNotice(`Product deleted: ${product.name}.`);
      if (stockForm.productId === product.id) {
        setShowStockForm(false);
      }
    } catch (error) {
      setNotice(error.message);
    } finally {
      setDeletingProduct(false);
    }
  };

  const importStock = async (rawText) => {
    try {
      const lines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (!lines.length) {
        setNotice("Paste stock rows first.");
        return;
      }

      const productBySku = new Map(state.products.map((p) => [p.sku.toLowerCase(), p]));
      const updates = [];
      const creates = [];
      const unknown = [];

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const cells = line.split(",").map((v) => (v || "").trim());
        if (!cells.length) continue;

        const first = cells[0].toLowerCase();
        if (i === 0 && (first === "sku" || first === "name")) {
          continue;
        }

        if (cells.length <= 2) {
          const [skuRaw, stockRaw] = cells;
          if (!skuRaw || stockRaw === "") continue;
          const product = productBySku.get(skuRaw.toLowerCase());
          if (!product) {
            unknown.push(skuRaw);
            continue;
          }
          const stock = Number(stockRaw);
          if (Number.isNaN(stock)) continue;
          updates.push({ productId: product.id, stock });
          continue;
        }

        const hasSizeColumn = cells.length >= 7;
        const name = cells[0];
        const size = hasSizeColumn ? (cells[1] || "") : "";
        const skuRaw = hasSizeColumn ? cells[2] : cells[1];
        const category = hasSizeColumn ? (cells[3] || "General") : (cells[2] || "General");
        const rawA = hasSizeColumn ? cells[4] : cells[3];
        const rawB = hasSizeColumn ? cells[5] : cells[4];
        const rawC = hasSizeColumn ? cells[6] : cells[5];
        if (!name || !skuRaw || rawA === undefined || rawB === undefined) continue;

        const hasBillingAndMrp = rawC !== undefined;
        const billingPrice = Number(rawA);
        const mrp = Number(hasBillingAndMrp ? rawB : rawA);
        const stockRaw = hasBillingAndMrp ? rawC : rawB;
        const stock = Number(stockRaw);
        if (Number.isNaN(billingPrice) || Number.isNaN(mrp) || Number.isNaN(stock)) continue;

        const existing = productBySku.get(skuRaw.toLowerCase());
        if (existing) {
          updates.push({ productId: existing.id, stock, billingPrice, mrp, size });
        } else {
          creates.push({ name, size, sku: skuRaw, category, billingPrice, mrp, price: mrp, stock });
        }
      }

      if (!updates.length && !creates.length) {
        setNotice("No valid stock rows found. Use: sku,stock OR name,sku,category,price,stock OR name,sku,category,billingPrice,mrp,stock OR name,size,sku,category,billingPrice,mrp,stock");
        return;
      }

      await Promise.all(
        updates.map((u) =>
          patchProduct(u.productId, { stock: u.stock, billingPrice: u.billingPrice, mrp: u.mrp, price: u.mrp, size: u.size })
        )
      );
      await Promise.all(creates.map((row) => createProduct(row)));
      setNotice(
        unknown.length
          ? `Imported ${updates.length} updates, created ${creates.length}. Unknown SKU: ${unknown.join(", ")}`
          : `Imported ${updates.length} updates, created ${creates.length} products.`
      );
    } catch (error) {
      setNotice(error.message);
    }
  };

  const onImportFileSelected = async (event) => {
    if (!canManageStock) {
      setNotice("Manager access cannot edit stock.");
      event.target.value = "";
      return;
    }
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await importStock(text);
    event.target.value = "";
  };

  const navItems = [
    { id: "dashboard", label: "Dashboard", iconClass: "dashboard", icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 13.5 12 5l8 8v6.2a1.3 1.3 0 0 1-1.3 1.3h-3.9v-5h-5.6v5H5.3A1.3 1.3 0 0 1 4 19.2z" />
      </svg>
    ) },
    { id: "customers", label: "Customers", iconClass: "customers", icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.8 18.2c0-3.1 2.4-5.4 5.2-5.4s5.2 2.3 5.2 5.4" />
        <circle cx="16.8" cy="9" r="2.4" />
        <path d="M14.4 17.8c.5-2 1.9-3.7 4.3-4.2 1.1-.2 2.1.2 2.9.8" />
      </svg>
    ) },
    { id: "stock", label: "Stock", iconClass: "stock", icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 7.5 12 4l7.5 3.5L12 11z" />
        <path d="M4.5 7.5V16.5L12 20v-9z" />
        <path d="M19.5 7.5V16.5L12 20v-9z" />
      </svg>
    ) },
    { id: "staff", label: "Staff", iconClass: "staff", icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="7.5" r="3.2" />
        <path d="M5 19c0-3.6 3-6 7-6s7 2.4 7 6" />
        <path d="M18.8 6.2h2.6M20.1 4.9v2.6" />
      </svg>
    ) },
    { id: "deliveries", label: "Deliveries", iconClass: "deliveries", icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.5 7.5h10.2v7.2H3.5z" />
        <path d="M13.7 10.2h3.2l2.1 2.4v2.1h-5.3z" />
        <circle cx="8" cy="18" r="1.8" />
        <circle cx="17.4" cy="18" r="1.8" />
      </svg>
    ) },
    { id: "reports", label: "Reports", iconClass: "reports", icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 18.5V10.8M12 18.5V6.5M18 18.5V13.2" />
        <path d="M4 19.5h16" />
      </svg>
    ) },
    { id: "loadings", label: "Loadings", iconClass: "loadings", icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.2 8.2h9.7v6.5H4.2z" />
        <path d="M13.9 10.4h3.4l2.5 2.7v1.6h-5.9z" />
        <path d="M7.2 6V4.2M10.8 6V4.2M16.3 6V4.2" />
        <circle cx="8.1" cy="17.8" r="1.6" />
        <circle cx="17.4" cy="17.8" r="1.6" />
      </svg>
    ) }
  ];

  return (
    <>
      {message && !/(error|invalid|required|cannot|unable|failed|not found|select|enter|type|exceeds)/i.test(String(message)) ? <p className="notice">{message}</p> : null}
      {notice && !/(error|invalid|required|cannot|unable|failed|not found|select|enter|type|exceeds)/i.test(String(notice)) ? <p className="notice">{notice}</p> : null}
      <main className="admin-shell">
        <button
          type="button"
          className={`admin-mobile-nav-toggle menu-toggle-btn ${mobileNavOpen ? "open" : ""}`}
          onClick={() => setMobileNavOpen((current) => !current)}
          aria-expanded={mobileNavOpen}
          aria-controls="admin-sidebar-nav"
          aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
        >
          <span className="menu-toggle-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="menu-toggle-label">{mobileNavOpen ? "Close" : "Menu"}</span>
        </button>

        {mobileNavOpen ? (
          <button
            type="button"
            className="admin-mobile-nav-backdrop"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close menu"
          />
        ) : null}

        <aside id="admin-sidebar-nav" className={`admin-sidebar ${mobileNavOpen ? "open" : ""}`}>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activePage === item.id ? "active" : ""}
              onClick={() => setActivePage(item.id)}
            >
              <span className="admin-sidebar-nav">
                <span className={`admin-sidebar-icon ${item.iconClass}`}>{item.icon}</span>
                <span className="admin-sidebar-label">{item.label}</span>
              </span>
            </button>
          ))}
          <section className="sidebar-bundle-guide" aria-label="Bundle counting guide">
            <div className="sidebar-bundle-guide-head">
              <span className="sidebar-bundle-guide-kicker">Bundle Logic</span>
              <strong>How Bundles Are Counted</strong>
            </div>
            <p className="sidebar-bundle-guide-note">
              The app converts units into bundles by bottle size. Anything left after full bundles is counted as singles.
            </p>
            <div className="sidebar-bundle-guide-grid">
              <article>
                <span>200 ml</span>
                <strong>24 per bundle</strong>
              </article>
              <article>
                <span>250 ml</span>
                <strong>30 per bundle</strong>
              </article>
              <article>
                <span>300 ml</span>
                <strong>24 per bundle</strong>
              </article>
              <article>
                <span>400 ml</span>
                <strong>24 per bundle</strong>
              </article>
              <article>
                <span>500 ml</span>
                <strong>24 per bundle</strong>
              </article>
              <article>
                <span>1000 ml</span>
                <strong>12 per bundle</strong>
              </article>
              <article>
                <span>1500 ml</span>
                <strong>12 per bundle</strong>
              </article>
              <article>
                <span>2000 ml</span>
                <strong>9 per bundle</strong>
              </article>
            </div>
            <p className="sidebar-bundle-guide-foot">
              Water rule: <strong>1000 ml = 15</strong>, <strong>1500 ml = 12</strong>, <strong>500 ml = 24</strong>.
            </p>
          </section>
          <div className="side-menu-footer">
            <a href="https://www.jnco.tech" target="_blank" rel="noreferrer">
              <img src="/powered.png" alt="Powered by" />
            </a>
          </div>
        </aside>

        <section className="admin-content">
          {activePage === "customers" ? (
            <section className="admin-mobile-section admin-customers-panel">
              <div className="customers-head">
                <h2>Customers</h2>
                <div className="customers-head-actions">
                  <button type="button" className="ghost" onClick={exportCustomerReport}>Export</button>
                  <button type="button" className="ghost" onClick={() => customerFileRef.current?.click()}>Import</button>
                  <input
                    ref={customerFileRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={onCustomerImportFileSelected}
                    hidden
                  />
                  <button type="button" className="customer-add-icon-btn" onClick={openCustomerAdd} title="Add Customer" aria-label="Add Customer">
                    <span className="fab-plus">+</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 20c0-4.5 3.6-8 8-8s8 3.5 8 8" />
                    </svg>
                  </button>
                </div>
              </div>
              <section className="customers-summary-card">
                <div className="customers-summary-divider">
                  <span>SUMMARY</span>
                </div>
                <div className="customers-summary-head">
                  <h3>Customer Summary</h3>
                  <p>Based on current list</p>
                </div>
                <div className="customers-summary-grid">
                  <article>
                    <span>Total Customers</span>
                    <strong>{customerPageSummary.totalCustomers}</strong>
                  </article>
                  <article>
                    <span>Active Customers</span>
                    <strong>{customerPageSummary.activeCustomers}</strong>
                  </article>
                  <article>
                    <span>Customers with Outstanding</span>
                    <strong>{customerPageSummary.customersWithOutstanding}</strong>
                  </article>
                  <article>
                    <span>Total Orders</span>
                    <strong>{customerPageSummary.totalOrders}</strong>
                  </article>
                  <article>
                    <span>Total Spent (LKR)</span>
                    <strong>{formatLkrValue(customerPageSummary.totalSpent || 0)}</strong>
                  </article>
                  <article>
                    <span>Available Credit (LKR)</span>
                    <strong>{formatLkrValue(customerPageSummary.totalAvailableCredit || 0)}</strong>
                  </article>
                  <article className="warn">
                    <span>Total Outstanding (LKR)</span>
                    <strong>{formatLkrValue(customerPageSummary.totalOutstanding || 0)}</strong>
                  </article>
                </div>
                <div className="customers-summary-foot">
                  <article>
                    <span>Top Customer</span>
                    <strong>{customerPageSummary.topCustomerName}</strong>
                    <p>LKR {formatLkrValue(customerPageSummary.topCustomerSpent || 0)}</p>
                  </article>
                  <article>
                    <span>Average Order Value</span>
                    <strong>LKR {formatLkrValue(customerPageSummary.averageOrderValue || 0)}</strong>
                  </article>
                </div>
              </section>
              <input
                className="customers-search search-icon-input"
                value={customerPanelSearch}
                onChange={(e) => setCustomerPanelSearch(e.target.value)}
                placeholder="Search Customer"
              />
              <div className="admin-table customer-table customers-table">
                <div className="customers-table-divider">
                  <span>CUSTOMERS TABLE</span>
                </div>
                <header>
                  <button type="button" className="th-sort" onClick={() => toggleSort("customers", "name")}>Name{sortMark("customers", "name")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("customers", "phone")}>Phone{sortMark("customers", "phone")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customers", "orders")}>Orders{sortMark("customers", "orders")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customers", "spent")}>Total Spent (LKR){sortMark("customers", "spent")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customers", "availableCredit")}>Available Credit (LKR){sortMark("customers", "availableCredit")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customers", "outstanding")}>Outstanding (LKR){sortMark("customers", "outstanding")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customers", "daysLeft")}>Days Left{sortMark("customers", "daysLeft")}</button>
                  </header>
                {sortedCustomerRows.length ? sortedCustomerRows.map((row) => (
                  <article
                    key={row.name}
                    className="customers-clickable-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => setCustomerDetailName(row.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setCustomerDetailName(row.name);
                      }
                    }}
                  >
                    <span>{row.name}</span>
                    <span>{row.phone || "-"}</span>
                    <span>{row.orders}</span>
                    <span>{formatLkrValue(row.spent || 0)}</span>
                    <span>{formatLkrValue(row.availableCredit || 0)}</span>
                    <span className={Number(row.outstanding || 0) > 0 ? "outstanding-text" : ""}>{formatLkrValue(row.outstanding || 0)}</span>
                    <span className={String(row.outstandingDaysLabel || "").toLowerCase().includes("overdue") ? "outstanding-text" : ""}>{row.outstandingDaysLabel || "-"}</span>
                  </article>
                )) : <p>No customer records yet.</p>}
              </div>
            </section>
          ) : null}

          {activePage === "stock" ? (
            <section className="admin-mobile-section admin-stock-panel">
              <h2>Stock</h2>
              {showStockForm ? (
                <div className="low-stock-modal" onClick={() => setShowStockForm(false)}>
                  <div className="low-stock-modal-card stock-entry-modal" onClick={(e) => e.stopPropagation()}>
                  <div className="low-stock-modal-head">
                      <h3>{stockMode === "add" ? "Stock Entry" : "Edit Stock"}</h3>
                      <button type="button" className="ghost" onClick={() => setShowStockForm(false)}>Close</button>
                    </div>
                    <div className="admin-inline-form stock-form-panel">
                      {stockMode === "add" ? (
                        <>
                          <label className="stock-form-field">
                            <span>Item Name</span>
                            <input
                              value={stockSearch}
                              onChange={(e) => onStockSearchChange(e.target.value)}
                              onFocus={() => setShowStockSuggestions(true)}
                              placeholder="Type item name"
                            />
                          </label>
                          {showStockSuggestions && stockSearchMatches.length ? (
                            <div className="stock-suggestions">
                              {stockSearchMatches.map((product) => (
                                <button key={product.id} type="button" onClick={() => onSelectExistingStockItem(product)}>
                                  {product.name} ({product.sku})
                                </button>
                              ))}
                            </div>
                          ) : null}
                          {stockForm.productId ? (
                            <p className="form-hint">Existing item selected. Quantity will be added to current stock.</p>
                          ) : (
                            <>
                              <p className="form-hint">No match selected. A new item will be created.</p>
                              <label className="stock-form-field">
                                <span>SKU</span>
                                <input value={newStockItemForm.sku} onChange={(e) => setNewStockItemForm((c) => ({ ...c, sku: e.target.value }))} placeholder="SKU (optional)" />
                              </label>
                              <label className="stock-form-field">
                                <span>Category</span>
                                <input value={newStockItemForm.category} onChange={(e) => setNewStockItemForm((c) => ({ ...c, category: e.target.value }))} placeholder="Category (optional)" />
                              </label>
                            </>
                          )}
                          <label className="stock-form-field">
                            <span>Billing Price (LKR)</span>
                            <input
                              type="number"
                              step="0.01"
                              value={newStockItemForm.billingPrice}
                              onChange={(e) => setNewStockItemForm((c) => ({ ...c, billingPrice: e.target.value }))}
                              placeholder="Billing Price (required)"
                            />
                          </label>
                          <label className="stock-form-field">
                            <span>Invoice Price (LKR)</span>
                            <input
                              type="number"
                              step="0.01"
                              value={newStockItemForm.invoicePrice}
                              onChange={(e) => setNewStockItemForm((c) => ({ ...c, invoicePrice: e.target.value }))}
                              placeholder="Invoice Price (required)"
                            />
                          </label>
                          <label className="stock-form-field">
                            <span>MRP (LKR)</span>
                            <input
                              type="number"
                              step="0.01"
                              value={newStockItemForm.mrp}
                              onChange={(e) => setNewStockItemForm((c) => ({ ...c, mrp: e.target.value }))}
                              placeholder="MRP (required)"
                            />
                          </label>
                          <label className="stock-form-field">
                            <span>Quantity</span>
                            <input type="number" value={stockForm.quantity} onChange={(e) => setStockForm((c) => ({ ...c, quantity: e.target.value }))} placeholder="Quantity" />
                          </label>
                        </>
                      ) : (
                        <>
                          <label className="stock-form-field">
                            <span>Product</span>
                            <select value={stockForm.productId} onChange={(e) => onStockProductChange(e.target.value)}>
                              {state.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                            </select>
                          </label>
                          <label className="stock-form-field">
                            <span>SKU</span>
                            <input value={stockForm.sku || ""} onChange={(e) => setStockForm((c) => ({ ...c, sku: e.target.value }))} placeholder="Edit SKU" />
                          </label>
                          <label className="stock-form-field">
                            <span>Invoice Price (LKR)</span>
                            <input type="number" step="0.01" value={stockForm.invoicePrice || ""} onChange={(e) => setStockForm((c) => ({ ...c, invoicePrice: e.target.value }))} placeholder="Invoice Price" />
                          </label>
                          <label className="stock-form-field">
                            <span>Billing Price (LKR)</span>
                            <input type="number" step="0.01" value={stockForm.billingPrice || ""} onChange={(e) => setStockForm((c) => ({ ...c, billingPrice: e.target.value }))} placeholder="Billing Price" />
                          </label>
                          <label className="stock-form-field">
                            <span>MRP (LKR)</span>
                            <input type="number" step="0.01" value={stockForm.mrp || ""} onChange={(e) => setStockForm((c) => ({ ...c, mrp: e.target.value }))} placeholder="MRP" />
                          </label>
                          <label className="stock-form-field">
                            <span>Stock</span>
                            <input type="number" value={stockForm.stock} onChange={(e) => setStockForm((c) => ({ ...c, stock: e.target.value }))} placeholder="Set stock" />
                          </label>
                        </>
                      )}
                      <div>
                        <button type="button" onClick={saveStock}>Save</button>
                        <button type="button" className="ghost" onClick={() => setShowStockForm(false)}>Cancel</button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="stock-current-head">
                <h3>Current Stock</h3>
                <div className="admin-page-actions stock-current-actions stock-actions-tech">
                  {canManageStock ? <button type="button" onClick={openStockAdd}>Add Stock</button> : null}
                  {canManageStock ? <button type="button" onClick={openStockEdit}>Edit Stock</button> : null}
                  <button type="button" onClick={exportStockReport}>Export Stock</button>
                  {canManageStock ? <button type="button" onClick={() => stockFileRef.current?.click()}>Import Stock</button> : null}
                  <input
                    ref={stockFileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden-file-input"
                    onChange={onImportFileSelected}
                  />
                </div>
              </div>
              <input
                className="admin-search-input stock-search-input search-icon-input"
                value={stockPanelSearch}
                onChange={(e) => setStockPanelSearch(e.target.value)}
                placeholder="Search product / SKU / size"
              />
              <section className="stock-summary-card">
                <div className="stock-summary-divider">
                  <span>STOCK SUMMARY</span>
                </div>
                <div className="stock-summary-head">
                  <h3>Inventory Snapshot</h3>
                  <p>Live from current filtered stock</p>
                </div>
                <div className="stock-summary-grid">
                  <article>
                    <span>Total SKUs</span>
                    <strong>{stockPageSummary.totalSkus}</strong>
                  </article>
                  <article>
                    <span>Total Units</span>
                    <strong>{stockPageSummary.totalUnits}</strong>
                  </article>
                  <article
                    role="button"
                    tabIndex={0}
                    onClick={() => setStockSummaryDetailMode("bundles")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setStockSummaryDetailMode("bundles");
                      }
                    }}
                  >
                    <span>Total Bundles</span>
                    <strong>{stockPageSummary.totalBundles}</strong>
                  </article>
                  <article
                    className="warn"
                    role="button"
                    tabIndex={0}
                    onClick={() => setStockSummaryDetailMode("low")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setStockSummaryDetailMode("low");
                      }
                    }}
                  >
                    <span>Low Stock</span>
                    <strong>{stockPageSummary.lowStockCount}</strong>
                  </article>
                  <article
                    className="warn soft"
                    role="button"
                    tabIndex={0}
                    onClick={() => setStockSummaryDetailMode("out")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setStockSummaryDetailMode("out");
                      }
                    }}
                  >
                    <span>Out of Stock</span>
                    <strong>{stockPageSummary.outOfStockCount}</strong>
                  </article>
                </div>
                <div className="stock-summary-foot">
                    <article>
                      <span>Invoice Value (LKR)</span>
                      <strong>{formatLkrValue(stockPageSummary.inventoryInvoice)}</strong>
                    </article>
                    <article>
                      <span>Inventory Cost (LKR)</span>
                      <strong>{formatLkrValue(stockPageSummary.inventoryCost)}</strong>
                    </article>
                  <article>
                    <span>Inventory MRP (LKR)</span>
                    <strong>{formatLkrValue(stockPageSummary.inventoryMrp)}</strong>
                  </article>
                  <article className="highlight">
                    <span>Highest Stock</span>
                    <strong>{stockPageSummary.topStockName}</strong>
                    <p>{stockPageSummary.topStockUnits} units</p>
                  </article>
                </div>
              </section>
              <div className="admin-table stock-table stock-table-tech">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stock", "sku")}>SKU{sortMark("stock", "sku")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stock", "invoicePrice")}>Invoice Price (LKR){sortMark("stock", "invoicePrice")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stock", "billingPrice")}>Billing Price (LKR){sortMark("stock", "billingPrice")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stock", "mrp")}>MRP (LKR){sortMark("stock", "mrp")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stock", "totalBundles")}>Total Bundles{sortMark("stock", "totalBundles")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stock", "stock")}>Stock{sortMark("stock", "stock")}</button>
                    <span className="th-action">Action</span>
                  </header>
                {sortedStockRows.map((item) => (
                  <article
                    key={item.id}
                    className="stock-clickable-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (canManageStock) openStockEditByRow(item);
                    }}
                    onKeyDown={(e) => {
                      if (canManageStock && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        openStockEditByRow(item);
                      }
                    }}
                    >
                      <span>{item.sku}</span>
                      <span>{formatLkrValue(item.invoicePrice ?? 0)}</span>
                      <span>{formatLkrValue(item.billingPrice ?? item.price ?? 0)}</span>
                      <span>{formatLkrValue(item.mrp ?? item.price ?? 0)}</span>
                      <span>{(() => {
                        const bundleSize = getBundleSize(item);
                        return bundleSize > 0 ? Math.floor(Number(item.stock || 0) / bundleSize) : 0;
                      })()}</span>
                      <span className={item.stock <= 25 ? "low" : ""}>{item.stock}</span>
                    <span className="action-cell">
                      {canManageStock ? (
                        <button
                          type="button"
                          className="row-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteStockProductById(item);
                          }}
                          disabled={deletingProduct}
                        >
                          Delete
                        </button>
                      ) : <span>-</span>}
                    </span>
                  </article>
                ))}
              </div>
              <div className="returned-stock-panel returned-stock-tech">
                <h3>Returned Stock</h3>
                <div className="admin-table returns-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("returns", "saleId")}>Sale ID{sortMark("returns", "saleId")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("returns", "item")}>Item{sortMark("returns", "item")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("returns", "qty")}>Qty{sortMark("returns", "qty")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("returns", "amount")}>Return Value (LKR){sortMark("returns", "amount")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("returns", "rep")}>Rep{sortMark("returns", "rep")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("returns", "reason")}>Reason{sortMark("returns", "reason")}</button>
                  </header>
                  {sortedAdminReturnRows.length ? sortedAdminReturnRows.map((row) => (
                    <article key={row.id}>
                      <span>#{row.saleId}</span>
                      <span>{row.item}</span>
                      <span>{row.qty}</span>
                      <span>{formatLkrValue(row.amount)}</span>
                      <span>{row.rep}</span>
                      <span>{row.reason}</span>
                    </article>
                  )) : <p className="form-hint">No returned stock records yet.</p>}
                </div>
              </div>
              <div className="returned-stock-panel returned-stock-tech">
                <h3>Stock Activity Log</h3>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={stockLogDateFrom} onChange={(e) => setStockLogDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={stockLogDateTo} onChange={(e) => setStockLogDateTo(e.target.value)} />
                  </label>
                </div>
                <input
                  className="search-icon-input imperfect-search-input"
                  value={stockLogSearch}
                  onChange={(e) => setStockLogSearch(e.target.value)}
                  placeholder="Search stock log by item / sku / user / action"
                />
                <div className="admin-table stock-log-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stockLog", "at")}>Date/Time{sortMark("stockLog", "at")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stockLog", "product")}>Product{sortMark("stockLog", "product")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stockLog", "sku")}>SKU{sortMark("stockLog", "sku")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stockLog", "beforeStock")}>Before{sortMark("stockLog", "beforeStock")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stockLog", "changeQty")}>Change{sortMark("stockLog", "changeQty")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stockLog", "afterStock")}>After{sortMark("stockLog", "afterStock")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stockLog", "by")}>By{sortMark("stockLog", "by")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("stockLog", "action")}>Action{sortMark("stockLog", "action")}</button>
                  </header>
                  {sortedStockMovementRows.length ? sortedStockMovementRows.map((row) => (
                    <article key={`stock-log-${row.id}`}>
                      <span>{row.atLabel}</span>
                      <span>{row.product}</span>
                      <span>{row.sku}</span>
                      <span>{Number(row.beforeStock || 0)}</span>
                      <span className={Number(row.changeQty || 0) < 0 ? "low" : ""}>
                        {Number(row.changeQty || 0) > 0 ? `+${row.changeQty}` : row.changeQty}
                      </span>
                      <span>{Number(row.afterStock || 0)}</span>
                      <span>{row.by}</span>
                      <span>{row.action}</span>
                    </article>
                  )) : <p className="form-hint">No stock activity found for selected range.</p>}
                </div>
              </div>
            </section>
          ) : null}

          {activePage === "staff" ? (
            <section className="admin-mobile-section">
              <div className="staff-head">
                <h2>Staff</h2>
                <div className="staff-head-actions">
                  {canManageUsers ? <button type="button" onClick={openStaffAdd}>Add Staff</button> : null}
                </div>
              </div>
              {showStaffForm ? (
                <div className="admin-inline-form">
                  <input value={staffForm.name} onChange={(e) => setStaffForm((c) => ({ ...c, name: e.target.value }))} placeholder="Staff name" />
                  <input value={staffForm.role} onChange={(e) => setStaffForm((c) => ({ ...c, role: e.target.value }))} placeholder="Role" />
                  <input value={staffForm.phone} onChange={(e) => setStaffForm((c) => ({ ...c, phone: e.target.value }))} placeholder="Phone" />
                  {!staffForm.authUserId ? (
                    <>
                      <input value={staffForm.username} onChange={(e) => setStaffForm((c) => ({ ...c, username: e.target.value }))} placeholder="Username" />
                      <input type="password" value={staffForm.password} onChange={(e) => setStaffForm((c) => ({ ...c, password: e.target.value }))} placeholder="Password" />
                      <select value={staffForm.authRole} onChange={(e) => setStaffForm((c) => ({ ...c, authRole: e.target.value }))}>
                        <option value="cashier">Cashier Login</option>
                        <option value="manager">Manager Login</option>
                        <option value="admin">Admin Login</option>
                      </select>
                    </>
                  ) : (
                    <>
                      <input value={staffForm.username} disabled placeholder="Username" />
                      <select value={staffForm.authRole} onChange={(e) => setStaffForm((c) => ({ ...c, authRole: e.target.value }))}>
                        <option value="cashier">Cashier Login</option>
                        <option value="manager">Manager Login</option>
                        <option value="admin">Admin Login</option>
                      </select>
                      <input
                        type="password"
                        value={staffForm.password}
                        onChange={(e) => setStaffForm((c) => ({ ...c, password: e.target.value }))}
                        placeholder="New Password (leave blank to keep current)"
                      />
                    </>
                  )}
                  <div>
                    <button type="button" onClick={saveStaff}>Save</button>
                    <button type="button" className="ghost" onClick={() => setShowStaffForm(false)}>Cancel</button>
                  </div>
                </div>
              ) : null}
              <input
                className="search-icon-input imperfect-search-input"
                value={staffSearch}
                onChange={(e) => setStaffSearch(e.target.value)}
                placeholder="Search staff"
              />
              <div className="admin-table staff-table">
                <header>
                  <button type="button" className="th-sort" onClick={() => toggleSort("staff", "name")}>Staff{sortMark("staff", "name")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("staff", "username")}>Username{sortMark("staff", "username")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("staff", "role")}>Access{sortMark("staff", "role")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("staff", "orders")}>Orders{sortMark("staff", "orders")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("staff", "revenue")}>Revenue{sortMark("staff", "revenue")}</button>
                  <span>Action</span>
                </header>
                {sortedStaffRows.filter((row) => matchesSearch(staffSearch, row.name, row.username, row.authRole, row.role)).length ? sortedStaffRows.filter((row) => matchesSearch(staffSearch, row.name, row.username, row.authRole, row.role)).map((row) => (
                  <article
                    key={`${row.authUserId || "auth-none"}-${row.staffId || "staff-none"}-${row.name}`}
                    className="staff-clickable-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (canManageUsers) openStaffEditByRow(row);
                    }}
                    onKeyDown={(e) => {
                      if (canManageUsers && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        openStaffEditByRow(row);
                      }
                    }}
                  >
                    <span>{row.name}</span>
                    <span>{row.username || "-"}</span>
                    <span>{row.authRole || row.role || "-"}</span>
                    <span>{row.orders}</span>
                    <span>{currency(row.revenue)}</span>
                    <span className="staff-row-action">
                      {canManageUsers ? (
                        <button
                          type="button"
                          className="danger-inline"
                          disabled={String(row.authUserId || "") === String(user?.id || "")}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteUserByRow(row);
                          }}
                        >
                          Delete
                        </button>
                      ) : (
                        "-"
                      )}
                    </span>
                  </article>
                )) : <p>No staff sales records yet.</p>}
              </div>
              <div className="staff-summary-divider">
                <span>STAFF SUMMARY</span>
              </div>
              <section className="staff-summary-card">
                <div className="staff-summary-top">
                  <article>
                    <span>Total Staff</span>
                    <strong>{staffPageSummary.totalStaff}</strong>
                  </article>
                  <article>
                    <span>Active Staff</span>
                    <strong>{staffPageSummary.activeStaff}</strong>
                  </article>
                  <article>
                    <span>Total Orders</span>
                    <strong>{staffPageSummary.totalOrders}</strong>
                  </article>
                  <article>
                    <span>Total Revenue (LKR)</span>
                    <strong>{formatLkrValue(staffPageSummary.totalRevenue)}</strong>
                  </article>
                </div>
                <div className="staff-summary-bottom">
                  <article>
                    <span>Avg Revenue / Staff (LKR)</span>
                    <strong>{formatLkrValue(staffPageSummary.avgRevenuePerStaff)}</strong>
                  </article>
                  <article className="staff-summary-highlight">
                    <span>Top Performer</span>
                    <strong>{staffPageSummary.topPerformerName}</strong>
                    <p>{staffPageSummary.topPerformerOrders} orders • {currency(staffPageSummary.topPerformerRevenue)}</p>
                  </article>
                </div>
              </section>
            </section>
          ) : null}

          {activePage === "deliveries" ? (
            <section className="admin-mobile-section deliveries-page">
              <div className="deliveries-head-row">
                <h2>Deliveries</h2>
                <div className="deliveries-head-actions">
                  {deliveriesView === "not-delivered" ? (
                    <button
                      type="button"
                      className="receipt-print-action deliveries-head-action-btn deliveries-head-print-btn"
                      onClick={() => printNotDeliveredReport(notDeliveredItemRows)}
                    >
                      Print
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost deliveries-head-action-btn deliveries-head-toggle-btn"
                    onClick={() => setDeliveriesView((current) => (current === "deliveries" ? "not-delivered" : "deliveries"))}
                  >
                    {deliveriesView === "deliveries" ? "Not Delivered" : "Back to Deliveries"}
                  </button>
                </div>
              </div>
              <div className="rep-date-filters">
                <select value={deliveryLorry} onChange={(e) => setDeliveryLorry(e.target.value)}>
                  <option value="all">All Lorries</option>
                  {ORDER_LORRIES.map((lorryName) => <option key={lorryName} value={lorryName}>{lorryName}</option>)}
                </select>
                <label className="rep-date-field">
                  <span>From</span>
                  <input type="date" value={deliveryDateFrom} onChange={(e) => setDeliveryDateFrom(e.target.value)} />
                </label>
                <label className="rep-date-field">
                  <span>To</span>
                  <input type="date" value={deliveryDateTo} onChange={(e) => setDeliveryDateTo(e.target.value)} />
                </label>
                <label className="rep-date-field">
                  <span>From Time</span>
                  <input type="time" value={deliveryTimeFrom} onChange={(e) => setDeliveryTimeFrom(e.target.value)} />
                </label>
                <label className="rep-date-field">
                  <span>To Time</span>
                  <input type="time" value={deliveryTimeTo} onChange={(e) => setDeliveryTimeTo(e.target.value)} />
                </label>
              </div>
              {deliveriesView === "not-delivered" ? (
                <>
                  <div className="admin-table deliveries-report-table not-delivered-min-table">
                    <header>
                      <span>Item</span>
                      <span>ND Qty</span>
                    </header>
                    {notDeliveredItemRows.length ? notDeliveredItemRows.map((row) => (
                      <article key={`nd-item-${row.item}`}>
                        <span>{row.item}</span>
                        <span>{row.qty}</span>
                      </article>
                    )) : <p>No not-delivered items found for selected range.</p>}
                  </div>
                </>
              ) : (
                <>
              <input
                className="search-icon-input imperfect-search-input"
                value={deliveriesSearch}
                onChange={(e) => setDeliveriesSearch(e.target.value)}
                placeholder="Search deliveries"
              />
              <div className="admin-table deliveries-table">
                <header>
                  <button type="button" className="th-sort delivery-col-id" onClick={() => toggleSort("deliveries", "id")}>Sale ID{sortMark("deliveries", "id")}</button>
                  <button type="button" className="th-sort delivery-col-date" onClick={() => toggleSort("deliveries", "when")}>Date/Time{sortMark("deliveries", "when")}</button>
                  <button type="button" className="th-sort delivery-col-rep" onClick={() => toggleSort("deliveries", "rep")}>Rep{sortMark("deliveries", "rep")}</button>
                  <button type="button" className="th-sort delivery-col-lorry" onClick={() => toggleSort("deliveries", "lorry")}>Lorry{sortMark("deliveries", "lorry")}</button>
                  <button type="button" className="th-sort delivery-col-total" onClick={() => toggleSort("deliveries", "total")}>Total (LKR){sortMark("deliveries", "total")}</button>
                  <button type="button" className="th-sort delivery-col-status" onClick={() => toggleSort("deliveries", "status")}>Status{sortMark("deliveries", "status")}</button>
                  <span className="th-action delivery-col-action">Action</span>
                </header>
                {sortedDeliveryRows.filter((row) => matchesSearch(deliveriesSearch, row.id, row.rep, row.lorry, row.when, row.sale?.customerName, row.confirmed ? "confirmed" : "pending")).length ? sortedDeliveryRows.filter((row) => matchesSearch(deliveriesSearch, row.id, row.rep, row.lorry, row.when, row.sale?.customerName, row.confirmed ? "confirmed" : "pending")).map((row) => (
                  <article key={`d-${row.id}`}>
                    <span className="delivery-col-id delivery-sale-cell">
                      <strong className="delivery-sale-id">#{row.id}</strong>
                      <small className="delivery-sale-customer">{row.sale.customerName || "Walk-in"}</small>
                      <small className="delivery-sale-meta">{row.when} • {row.rep}</small>
                    </span>
                    <span className="delivery-col-date delivery-cell-date">{row.when}</span>
                    <span className="delivery-col-rep">{row.rep}</span>
                    <span className="delivery-col-lorry">{row.lorry}</span>
                    <span className="delivery-col-total">{formatLkrValue(row.total || 0)}</span>
                    <span className="delivery-col-status">
                      <span className={row.confirmed ? "delivery-status confirmed" : "delivery-status pending"}>
                        {row.confirmed ? "Confirmed" : "Pending"}
                      </span>
                    </span>
                    <span className="action-cell delivery-col-action">
                      <button type="button" className="delivery-action-btn" onClick={() => openDeliveryModal(row.sale)}>
                        {row.confirmed ? "Update" : "Confirm"}
                      </button>
                    </span>
                  </article>
                )) : <p>No delivery bills found for selected filters.</p>}
              </div>
              <div className="report-head deliveries-report-head" style={{ marginTop: "0.65rem" }}>
                <h3>Delivered Items Report</h3>
              </div>
              <div className="rep-date-filters">
                <label className="rep-date-field">
                  <span>From</span>
                  <input type="date" value={deliveryReportDateFrom} onChange={(e) => setDeliveryReportDateFrom(e.target.value)} />
                </label>
                <label className="rep-date-field">
                  <span>To</span>
                  <input type="date" value={deliveryReportDateTo} onChange={(e) => setDeliveryReportDateTo(e.target.value)} />
                </label>
              </div>
              <div className="delivery-kpi-grid">
                <article>
                  <span>Sold Qty</span>
                  <strong>{soldTotals.qty}</strong>
                </article>
                <article>
                  <span>Sold Value</span>
                  <strong>{currency(soldTotals.value)}</strong>
                </article>
                <article>
                  <span>Delivered Qty</span>
                  <strong>{deliveredTotals.qty}</strong>
                </article>
                <article>
                  <span>Delivered Value</span>
                  <strong>{currency(deliveredTotals.value)}</strong>
                </article>
              </div>
              <input
                className="search-icon-input imperfect-search-input"
                value={deliveredItemsSearch}
                onChange={(e) => setDeliveredItemsSearch(e.target.value)}
                placeholder="Search delivered items"
              />
              <div className="admin-table deliveries-report-table">
                <header>
                  <button type="button" className="th-sort" onClick={() => toggleSort("deliveredItems", "item")}>Item{sortMark("deliveredItems", "item")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("deliveredItems", "sku")}>SKU{sortMark("deliveredItems", "sku")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("deliveredItems", "qty")}>Delivered Qty{sortMark("deliveredItems", "qty")}</button>
                  <button type="button" className="th-sort" onClick={() => toggleSort("deliveredItems", "value")}>Delivered Value{sortMark("deliveredItems", "value")}</button>
                </header>
                {sortedDeliveredItemRows.filter((row) => matchesSearch(deliveredItemsSearch, row.item, row.sku)).length ? sortedDeliveredItemRows.filter((row) => matchesSearch(deliveredItemsSearch, row.item, row.sku)).map((row) => (
                  <article key={`dr-${row.key}`}>
                    <span>{row.item}</span>
                    <span>{row.sku}</span>
                    <span>{row.qty}</span>
                    <span>{currency(row.value)}</span>
                  </article>
                )) : <p>No delivered item records for selected filters.</p>}
              </div>
                </>
              )}
            </section>
          ) : null}

          {activePage === "dashboard" ? (
            <div className="admin-mobile admin-dashboard">
                <div className="dashboard-notification-row">
                  <button
                    type="button"
                    className="dashboard-bell-button"
                    onClick={() => setShowCreditLimitAlertDetails(true)}
                    aria-label="Open credit limit notifications"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M15 17H5.8c-.7 0-1.1-.8-.7-1.4l1.2-1.8V10a5.7 5.7 0 1 1 11.4 0v3.8l1.2 1.8c.4.6 0 1.4-.7 1.4H15" />
                      <path d="M9.5 17a2.5 2.5 0 0 0 5 0" />
                    </svg>
                    {creditLimitAlertSummary.count > 0 ? <span className="dashboard-bell-badge">{creditLimitAlertSummary.count > 9 ? "9+" : creditLimitAlertSummary.count}</span> : null}
                  </button>
                  <div className="dashboard-notification-copy">
                    <strong>Notifications</strong>
                    <span>{creditLimitAlertSummary.count ? `${creditLimitAlertSummary.count} customer limit alert${creditLimitAlertSummary.count === 1 ? "" : "s"}` : "No credit-limit alerts right now"}</span>
                  </div>
                </div>
                {!isManager ? (
                  <div className="dashboard-notification-row manager-access-row">
                    <div className="dashboard-notification-copy">
                      <strong>Manager Full Access</strong>
                      <span>{managerFullAccessEnabled ? "Manager can use restricted admin actions" : "Manager is limited to standard manager permissions"}</span>
                    </div>
                    <button
                      type="button"
                      className={`manager-access-switch ${managerFullAccessEnabled ? "on" : ""}`}
                      onClick={handleManagerFullAccessToggle}
                      disabled={managerAccessPending}
                      aria-pressed={managerFullAccessEnabled}
                    >
                      <span>{managerAccessPending ? "..." : managerFullAccessEnabled ? "ON" : "OFF"}</span>
                    </button>
                  </div>
                ) : null}
                {upcomingChequeSummary.count ? (
                  <button type="button" className="admin-mobile-section dashboard-headline-banner cheque-headline-banner dashboard-headline-button" onClick={() => setShowChequeAlertDetails(true)}>
                    <strong>Cheque Alert Tomorrow</strong>
                    <span>
                      {upcomingChequeSummary.count} cheque{upcomingChequeSummary.count === 1 ? "" : "s"} • LKR {formatLkrValue(upcomingChequeSummary.total)} • {upcomingChequeSummary.rows[0]?.customer || "-"} • #{upcomingChequeSummary.rows[0]?.saleId || "-"} • {upcomingChequeSummary.rows[0]?.bank || "-"}
                    </span>
                  </button>
                ) : null}
                <section className="admin-mobile-section dashboard-snapshot-panel">
                  <h2>Admin Snapshot</h2>
                  <div className="snapshot-layout">
                    <div className="snapshot-grid">
                      <article><p>Total sales</p><strong>{dashboard.salesCount}</strong></article>
                      <article><p>Today sales</p><strong>{dashboard.todaySalesCount}</strong></article>
                      <article className="snapshot-card-outstanding snapshot-card-outstanding-total">
                        <p>Total Outstanding</p>
                        <strong>{formatLkrValue(customerPageSummary.totalOutstanding || 0)}</strong>
                        <small className="snapshot-subvalue">Without Today: {formatLkrValue(totalOutstandingExcludingToday)}</small>
                      </article>
                      <article className="snapshot-card-outstanding snapshot-card-outstanding-today"><p>Today Outstanding</p><strong>{formatLkrValue(dashboard.todayOutstanding || 0)}</strong></article>
                      <article><p>Today Ordered Value</p><strong>{dashboard.todayRevenue.toFixed(0)}</strong></article>
                      <article><p>Low Stock</p><strong>{dashboard.lowStockItems.length}</strong></article>
                    </div>
                    <div className="snapshot-sidecards">
                      <div className="dashboard-profit-card">
                        <div className="dashboard-profit-head">
                          <div>
                            <span className="dashboard-profit-eyebrow">Total Net Profit</span>
                            <div className="dashboard-profit-date-range">
                              <label className="dashboard-profit-date-field">
                                <span>From</span>
                                <input type="date" value={dashboardProfitDateFrom} onChange={(e) => setDashboardProfitDateFrom(e.target.value)} />
                              </label>
                              <label className="dashboard-profit-date-field">
                                <span>To</span>
                                <input type="date" value={dashboardProfitDateTo} onChange={(e) => setDashboardProfitDateTo(e.target.value)} />
                              </label>
                            </div>
                          </div>
                          <strong>LKR {formatLkrValue(dashboardProfitSummary.profit)}</strong>
                        </div>
                        <div className="dashboard-profit-meta">
                          <span>Revenue <b>LKR {formatLkrValue(dashboardProfitSummary.revenue)}</b></span>
                          <span>Invoice Cost <b>LKR {formatLkrValue(dashboardProfitSummary.cost)}</b></span>
                        </div>
                        <div className="dashboard-profit-foot">
                          <span>{dashboardProfitSummary.filteredSalesCount} bill{dashboardProfitSummary.filteredSalesCount === 1 ? "" : "s"} in range</span>
                        </div>
                        <p>Net margin {dashboardProfitSummary.margin}%</p>
                      </div>
                      <button type="button" className="low-stock-card" onClick={() => setShowLowStock(true)}>
                        <strong>Low Stock</strong>
                        <span>Click to popup the list</span>
                      </button>
                      {overdueCreditSummary.count ? (
                        <div className="dashboard-alert-card">
                          <strong>Overdue Credit Alert</strong>
                          <span>{overdueCreditSummary.count} customer(s) • LKR {formatLkrValue(overdueCreditSummary.total)}</span>
                          <p>
                            Top overdue: {overdueCreditSummary.top?.customer || "-"}
                            {" • "}
                            {overdueCreditSummary.top?.maxDays || 0} days
                          </p>
                        </div>
                      ) : null}
                      {creditLimitAlertSummary.count ? (
                        <div className="dashboard-alert-card dashboard-alert-card-credit-limit">
                          <strong>Credit Limit Exceeded</strong>
                          <span>{creditLimitAlertSummary.count} customer(s) • LKR {formatLkrValue(creditLimitAlertSummary.totalExceeded)} over limit</span>
                          <p>
                            Top alert: {creditLimitAlertSummary.top?.customer || "-"}
                            {" • exceeded by "}
                            {formatLkrValue(creditLimitAlertSummary.top?.exceededBy || 0)}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </section>

              <section className="admin-mobile-section sales-day-panel dashboard-chart-panel">
                <h2>Sales Chart by Day</h2>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={chartDateFrom} onChange={(e) => setChartDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={chartDateTo} onChange={(e) => setChartDateTo(e.target.value)} />
                  </label>
                </div>
                <div className="bar-chart">
                  {chartData.map((item) => (
                    <div key={item.key} className="bar-col">
                      <div className="bar-value">{item.count}</div>
                      <div className="bar-wrap">
                        <div className="bar" style={{ height: `${(item.count / maxCount) * 100}%` }} />
                      </div>
                      <div className="bar-meta">{formatLkrValue(item.revenue || 0)}</div>
                      <div className="bar-label">{item.short}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="admin-mobile-section rep-chart-panel dashboard-chart-panel">
                <div className="chart-title-row rep-title-row">
                  <h2 className="rep-chart-title">Sales Chart by Rep</h2>
                  <div className="rep-search rep-search-wide">
                    <select value={selectedRep} onChange={(e) => setSelectedRep(e.target.value)}>
                      <option value="">All reps</option>
                      {repChartData.map((item) => (
                        <option key={item.rep} value={item.rep}>{item.rep}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={repDateFrom} onChange={(e) => setRepDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={repDateTo} onChange={(e) => setRepDateTo(e.target.value)} />
                  </label>
                </div>
                <div className="rep-result">
                  Matched reps: {filteredRepChartData.length}
                  {(repDateFrom || repDateTo) ? ` • Range: ${repDateFrom || "start"} to ${repDateTo || "today"}` : ""}
                </div>
                <div className="rep-chart-metrics">
                  <article>
                    <span>Total Orders</span>
                    <strong>{filteredRepChartData.reduce((sum, item) => sum + Number(item.count || 0), 0)}</strong>
                  </article>
                  <article>
                    <span>Top Rep</span>
                    <strong>{filteredRepChartData[0]?.rep || "-"}</strong>
                  </article>
                  <article>
                    <span>Top Orders</span>
                    <strong>{filteredRepChartData[0]?.count || 0}</strong>
                  </article>
                </div>
                <div className="bar-chart rep-bar-chart">
                  {filteredRepChartData.map((item) => (
                    <div key={item.rep} className="bar-col">
                      <div className="bar-value">{item.count}</div>
                      <div className="bar-wrap">
                        <div className="bar" style={{ height: `${(item.count / repMaxCount) * 100}%` }} />
                      </div>
                      <div className="bar-label">{item.rep}</div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : null}

          {activePage === "reports" ? (
            <div className="admin-mobile admin-reports">
              <section className="admin-mobile-section reports-subnav-panel">
                <div className="reports-subnav-head">
                  <div>
                    <span className="reports-subnav-kicker">Reports</span>
                    <h2>{(REPORT_SUBPAGES.find((item) => item.id === reportSubpage) || REPORT_SUBPAGES[0]).label}</h2>
                  </div>
                  <div className="reports-subnav" ref={reportMenuRef}>
                    <button
                      type="button"
                      className={`reports-subnav-trigger ${reportMenuOpen ? "open" : ""}`}
                      onClick={() => setReportMenuOpen((open) => !open)}
                    >
                      {(REPORT_SUBPAGES.find((item) => item.id === reportSubpage) || REPORT_SUBPAGES[0]).label}
                    </button>
                    {reportMenuOpen ? (
                      <div className="reports-subnav-menu">
                        {REPORT_SUBPAGES.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={reportSubpage === item.id ? "active" : ""}
                            onClick={() => {
                              setReportSubpage(item.id);
                              setReportMenuOpen(false);
                            }}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>

              {reportSubpage === "item-wise" ? (
              <section className="admin-mobile-section report-panel report-itemwise-panel">
                <div className="report-head">
                  <h2>Item Wise Report</h2>
                  <select value={itemReportLorry} onChange={(e) => setItemReportLorry(e.target.value)}>
                    <option value="all">All Lorries</option>
                    {ORDER_LORRIES.map((lorryName) => <option key={lorryName} value={lorryName}>{lorryName}</option>)}
                  </select>
                </div>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={itemDateFrom} onChange={(e) => setItemDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={itemDateTo} onChange={(e) => setItemDateTo(e.target.value)} />
                  </label>
                </div>
                <input
                  className="search-icon-input imperfect-search-input"
                  value={itemWiseSearch}
                  onChange={(e) => setItemWiseSearch(e.target.value)}
                  placeholder="Search item wise report"
                />
                <div className="admin-table item-wise-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "name")}>Item{sortMark("itemWise", "name")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "sku")}>SKU{sortMark("itemWise", "sku")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "qty")}>Sold Qty{sortMark("itemWise", "qty")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "bundles")}>Bundles{sortMark("itemWise", "bundles")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("itemWise", "singles")}>Singles{sortMark("itemWise", "singles")}</button>
                  </header>
                  {sortedItemWiseRows.filter((row) => matchesSearch(itemWiseSearch, row.name, row.sku, row.size, row.category)).length ? sortedItemWiseRows.filter((row) => matchesSearch(itemWiseSearch, row.name, row.sku, row.size, row.category)).map((row) => (
                    <article key={row.key}>
                      <span>{row.name}</span>
                      <span>{row.sku}</span>
                      <span>{row.qty}</span>
                      <span>{getBundleBreakdown(row).bundles}</span>
                      <span>{getBundleBreakdown(row).singles}</span>
                    </article>
                  )) : <p>No item-wise records yet.</p>}
                </div>
              </section>
              ) : null}

              {reportSubpage === "sales-wise" ? (
              <section className="admin-mobile-section report-panel report-saleswise-panel">
                <h2>Sales Wise Report</h2>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={salesDateFrom} onChange={(e) => setSalesDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={salesDateTo} onChange={(e) => setSalesDateTo(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>From Time</span>
                    <input type="time" value={salesTimeFrom} onChange={(e) => setSalesTimeFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To Time</span>
                    <input type="time" value={salesTimeTo} onChange={(e) => setSalesTimeTo(e.target.value)} />
                  </label>
                </div>
                <div className="row" style={{ justifyContent: "flex-end", marginTop: "-0.2rem", marginBottom: "0.2rem" }}>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setSalesDateFrom(loadingDateFrom || "");
                      setSalesDateTo(loadingDateTo || "");
                      setSalesTimeFrom(loadingTimeFrom || "");
                      setSalesTimeTo(loadingTimeTo || "");
                    }}
                  >
                    Use Loadings Date/Time Range
                  </button>
                </div>
                <div className="sales-range-kpi">
                  <span className="sales-range-kpi-label">Selected Range Total Sale Value</span>
                  <strong className="sales-range-kpi-value">{currency(salesRangeTotal)}</strong>
                </div>
                <input
                  className="search-icon-input imperfect-search-input"
                  value={salesWiseSearch}
                  onChange={(e) => setSalesWiseSearch(e.target.value)}
                  placeholder="Search sales wise report"
                />
                <div className="admin-table sales-wise-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("salesWise", "id")}>Sale ID{sortMark("salesWise", "id")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("salesWise", "when")}>Date{sortMark("salesWise", "when")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("salesWise", "lorry")}>Lorry{sortMark("salesWise", "lorry")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("salesWise", "total")}>Total<br />(LKR){sortMark("salesWise", "total")}</button>
                    <span className="th-action">Actions</span>
                  </header>
                  {sortedSalesWiseRows.filter((row) => matchesSearch(salesWiseSearch, row.id, row.rep, row.lorry, row.when, row.raw?.customerName)).length ? sortedSalesWiseRows.filter((row) => matchesSearch(salesWiseSearch, row.id, row.rep, row.lorry, row.when, row.raw?.customerName)).slice(0, 50).map((row) => (
                    <article key={row.id}>
                      <span className="sales-id-cell">
                        <strong>#{row.id}</strong>
                        <small>{row.rep}</small>
                      </span>
                      <span>{row.when}</span>
                      <span>{row.lorry}</span>
                      <span>{formatLkrValue(row.total || 0)}</span>
                      <span className="action-cell">
                        <button type="button" className="ghost" onClick={() => setViewSaleId(String(row.id))}>View</button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => openAdminSaleEdit(row.raw)}
                          disabled={Boolean(row.raw?.deliveryConfirmedAt) || Boolean((row.raw?.deliveryAdjustments || []).length) || (state.returns || []).some((ret) => String(ret.saleId) === String(row.id))}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="row-danger"
                          onClick={() => deleteAdminSale(row.raw)}
                          disabled={deletingSaleId === String(row.id) || Boolean(row.raw?.deliveryConfirmedAt) || Boolean((row.raw?.deliveryAdjustments || []).length)}
                        >
                          {deletingSaleId === String(row.id) ? "..." : "??"}
                        </button>
                      </span>
                    </article>
                  )) : <p>No sales records yet.</p>}
                </div>
              </section>
              ) : null}

              {reportSubpage === "cheque-summary" ? (
              <section className="admin-mobile-section report-panel cheque-report-panel">
                <h2>Cheque Summary</h2>
                <div className="cheque-summary-grid">
                  <article
                    role="button"
                    tabIndex={0}
                    className="cheque-summary-clickable"
                    onClick={() => setShowChequeSummaryDetails(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setShowChequeSummaryDetails(true);
                      }
                    }}
                  >
                    <span>Total Cheques</span>
                    <strong>{chequeReportSummary.chequeCount}</strong>
                  </article>
                  <article>
                    <span>Total Cheque Amount (LKR)</span>
                    <strong>{formatLkrValue(chequeReportSummary.totalChequeAmount)}</strong>
                  </article>
                  <article>
                    <span>Average Cheque (LKR)</span>
                    <strong>{formatLkrValue(chequeReportSummary.avgChequeAmount)}</strong>
                  </article>
                  <article className="warn">
                    <span>Outstanding on Cheques (LKR)</span>
                    <strong>{formatLkrValue(chequeReportSummary.totalOutstanding)}</strong>
                  </article>
                </div>
                <div className="cheque-summary-meta">
                  <article>
                    <span>Latest Cheque No</span>
                    <strong>{chequeReportSummary.latestChequeNo}</strong>
                  </article>
                  <article>
                    <span>Latest Cheque Date</span>
                    <strong>{chequeReportSummary.latestChequeDate}</strong>
                  </article>
                  <article>
                    <span>Latest Bank</span>
                    <strong>{chequeReportSummary.latestChequeBank}</strong>
                  </article>
                </div>
              </section>
              ) : null}

              {reportSubpage === "customer-wise" ? (
              <section className="admin-mobile-section report-panel report-customerwise-panel">
                <h2>Customer Wise Report</h2>
                <input
                  className="search-icon-input imperfect-search-input"
                  value={customerWiseSearch}
                  onChange={(e) => setCustomerWiseSearch(e.target.value)}
                  placeholder="Search customer wise report"
                />
                <div className="admin-table customer-wise-report-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customerWise", "name")}>Customer{sortMark("customerWise", "name")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customerWise", "orders")}>Orders{sortMark("customerWise", "orders")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customerWise", "spent")}>Total Spent (LKR){sortMark("customerWise", "spent")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("customerWise", "lastAt")}>Last Purchase{sortMark("customerWise", "lastAt")}</button>
                  </header>
                {sortedCustomerWiseRows.filter((row) => matchesSearch(customerWiseSearch, row.name, row.lastAt)).length ? sortedCustomerWiseRows.filter((row) => matchesSearch(customerWiseSearch, row.name, row.lastAt)).map((row) => (
                  <article key={row.name}>
                    <span>{row.name}</span>
                    <span>{row.orders}</span>
                    <span>{formatLkrValue(row.spent || 0)}</span>
                    <span>{row.lastAt ? new Date(row.lastAt).toLocaleDateString() : "-"}</span>
                  </article>
                )) : <p>No customer-wise records yet.</p>}
              </div>
                <section className="customers-summary-card">
                  <div className="customers-summary-divider">
                    <span>SUMMARY</span>
                  </div>
                  <div className="customers-summary-head">
                    <h3>Customer Snapshot</h3>
                    <p>Live from filtered customer records</p>
                  </div>
                  <div className="customers-summary-grid">
                    <article>
                      <span>Total Customers</span>
                      <strong>{customerPageSummary.totalCustomers}</strong>
                    </article>
                    <article>
                      <span>Active Customers</span>
                      <strong>{customerPageSummary.activeCustomers}</strong>
                    </article>
                    <article className="warn">
                      <span>With Outstanding</span>
                      <strong>{customerPageSummary.customersWithOutstanding}</strong>
                    </article>
                  </div>
                  <div className="customers-summary-foot">
                    <article>
                      <span>Total Orders</span>
                      <strong>{customerPageSummary.totalOrders}</strong>
                      <p>Avg order value: {currency(customerPageSummary.averageOrderValue)}</p>
                    </article>
                    <article>
                      <span>Total Spent</span>
                      <strong>{currency(customerPageSummary.totalSpent)}</strong>
                      <p className="outstanding-text">Outstanding: {currency(customerPageSummary.totalOutstanding)}</p>
                    </article>
                    <article>
                      <span>Top Customer</span>
                      <strong>{customerPageSummary.topCustomerName}</strong>
                      <p>{currency(customerPageSummary.topCustomerSpent)}</p>
                    </article>
                  </div>
                </section>
              </section>
              ) : null}

              {reportSubpage === "rep-outstanding" ? (
              <section className="admin-mobile-section report-panel report-rep-outstanding-panel">
                <h2>Rep Wise Customer Outstanding</h2>
                <input
                  className="search-icon-input imperfect-search-input"
                  value={repOutstandingSearch}
                  onChange={(e) => setRepOutstandingSearch(e.target.value)}
                  placeholder="Search rep outstanding"
                />
                <div className="rep-outstanding-summary-grid">
                  <article>
                    <span>Reps with Outstanding</span>
                    <strong>{repOutstandingSummary.reps}</strong>
                  </article>
                  <article>
                    <span>Outstanding Bills</span>
                    <strong>{repOutstandingSummary.bills}</strong>
                  </article>
                  <article>
                    <span>Affected Customers</span>
                    <strong>{repOutstandingSummary.customers}</strong>
                  </article>
                  <article className="warn">
                    <span>Total Outstanding (LKR)</span>
                    <strong>{formatLkrValue(repOutstandingSummary.outstanding)}</strong>
                  </article>
                </div>
                <div className="admin-table rep-outstanding-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("repOutstanding", "rep")}>Rep{sortMark("repOutstanding", "rep")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("repOutstanding", "customers")}>Customers{sortMark("repOutstanding", "customers")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("repOutstanding", "bills")}>Bills{sortMark("repOutstanding", "bills")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("repOutstanding", "outstanding")}>Outstanding (LKR){sortMark("repOutstanding", "outstanding")}</button>
                  </header>
                  {sortedRepOutstandingRows.filter((row) => matchesSearch(repOutstandingSearch, row.rep)).length ? sortedRepOutstandingRows.filter((row) => matchesSearch(repOutstandingSearch, row.rep)).map((row) => (
                    <article key={`rep-out-${row.rep}`}>
                      <span>{row.rep}</span>
                      <span
                        className="rep-outstanding-detail-trigger"
                        role="button"
                        tabIndex={0}
                        onClick={() => setRepOutstandingDetailRep(row.rep)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setRepOutstandingDetailRep(row.rep);
                          }
                        }}
                      >
                        {row.customers}
                      </span>
                      <span>{row.bills}</span>
                      <span className="outstanding-text">{formatLkrValue(row.outstanding)}</span>
                    </article>
                  )) : <p>No rep outstanding balances in selected range.</p>}
                </div>
              </section>
              ) : null}

              {reportSubpage === "delivery-report" ? (
              <section className="admin-mobile-section report-panel report-delivery-panel">
                <div className="delivery-report-divider">
                  <span>DELIVERY INTELLIGENCE</span>
                </div>
                <div className="report-head">
                  <h2>Delivery Report</h2>
                  <select value={reportDeliveryLorry} onChange={(e) => setReportDeliveryLorry(e.target.value)}>
                    <option value="all">All Lorries</option>
                    {ORDER_LORRIES.map((lorryName) => <option key={lorryName} value={lorryName}>{lorryName}</option>)}
                  </select>
                </div>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={reportDeliveryDateFrom} onChange={(e) => setReportDeliveryDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={reportDeliveryDateTo} onChange={(e) => setReportDeliveryDateTo(e.target.value)} />
                  </label>
                </div>
                <input
                  className="search-icon-input imperfect-search-input"
                  value={reportDeliverySearch}
                  onChange={(e) => setReportDeliverySearch(e.target.value)}
                  placeholder="Search delivery report"
                />
                <div className="delivery-report-kpi-grid">
                  <article><span>Total Bills</span><strong>{reportDeliverySummary.totalBills}</strong></article>
                  <article><span>Confirmed</span><strong>{reportDeliverySummary.confirmedBills}</strong></article>
                  <article><span>Pending</span><strong>{reportDeliverySummary.pendingBills}</strong></article>
                  <article><span>Sold Qty</span><strong>{reportDeliverySummary.soldQtyTotal}</strong></article>
                  <article><span>Delivered Qty</span><strong>{reportDeliverySummary.deliveredQtyTotal}</strong></article>
                  <article><span>Undelivered Qty</span><strong>{reportDeliverySummary.undeliveredQtyTotal}</strong></article>
                  <article><span>Delivered Value (LKR)</span><strong>{formatLkrValue(reportDeliverySummary.deliveredValueTotal)}</strong></article>
                  <article><span>Delivery Rate</span><strong>{reportDeliverySummary.deliveryRate}%</strong></article>
                </div>
                <div className="admin-table delivery-report-sales-table">
                  <header>
                    <button type="button" className="th-sort" onClick={() => toggleSort("deliveryReport", "id")}>Sale ID{sortMark("deliveryReport", "id")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("deliveryReport", "date")}>Date{sortMark("deliveryReport", "date")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("deliveryReport", "rep")}>Rep{sortMark("deliveryReport", "rep")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("deliveryReport", "lorry")}>Lorry{sortMark("deliveryReport", "lorry")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("deliveryReport", "status")}>Status{sortMark("deliveryReport", "status")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("deliveryReport", "soldQty")}>Sold{sortMark("deliveryReport", "soldQty")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("deliveryReport", "undeliveredQty")}>ND{sortMark("deliveryReport", "undeliveredQty")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("deliveryReport", "deliveredQty")}>Delivered{sortMark("deliveryReport", "deliveredQty")}</button>
                    <button type="button" className="th-sort" onClick={() => toggleSort("deliveryReport", "deliveredValue")}>Value (LKR){sortMark("deliveryReport", "deliveredValue")}</button>
                  </header>
                  {sortedReportDeliveryRows.filter((row) => matchesSearch(reportDeliverySearch, row.id, row.date, row.rep, row.lorry, row.status)).length ? sortedReportDeliveryRows.filter((row) => matchesSearch(reportDeliverySearch, row.id, row.date, row.rep, row.lorry, row.status)).map((row) => (
                    <article key={`rdr-${row.id}`}>
                      <span>#{row.id}</span>
                      <span>{row.date}</span>
                      <span>{row.rep}</span>
                      <span>{row.lorry}</span>
                      <span>
                        <span className={row.status === "Confirmed" ? "delivery-status confirmed" : "delivery-status pending"}>
                          {row.status}
                        </span>
                      </span>
                      <span>{row.soldQty}</span>
                      <span>{row.undeliveredQty}</span>
                      <span>{row.deliveredQty}</span>
                      <span>{formatLkrValue(row.deliveredValue)}</span>
                    </article>
                  )) : <p>No delivery report records for selected filters.</p>}
                </div>
              </section>
              ) : null}
            </div>
          ) : null}

          {activePage === "loadings" ? (
            <div className="admin-mobile loadings-page">
              <section className="admin-mobile-section loading-range-panel">
                <div className="report-head">
                  <h2>Loading Date Range</h2>
                  <button type="button" onClick={handleResetLorryCount} disabled={resettingLorryCount}>
                    {resettingLorryCount ? "Resetting..." : "Reset Lorry Count"}
                  </button>
                </div>
                <div className="rep-date-filters">
                  <label className="rep-date-field">
                    <span>From</span>
                    <input type="date" value={loadingDateFrom} onChange={(e) => setLoadingDateFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>From Time</span>
                    <input type="time" value={loadingTimeFrom} onChange={(e) => setLoadingTimeFrom(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To</span>
                    <input type="date" value={loadingDateTo} onChange={(e) => setLoadingDateTo(e.target.value)} />
                  </label>
                  <label className="rep-date-field">
                    <span>To Time</span>
                    <input type="time" value={loadingTimeTo} onChange={(e) => setLoadingTimeTo(e.target.value)} />
                  </label>
                </div>
                <input
                  className="search-icon-input imperfect-search-input"
                  value={loadingsSearch}
                  onChange={(e) => setLoadingsSearch(e.target.value)}
                  placeholder="Search loading rows"
                />
                <p className="form-hint">
                  Resets only the lorry capacity count used for new orders. Existing sales and loading reports stay unchanged.
                </p>
              </section>
              <section className="admin-mobile-section loading-lorry-selector-panel">
                <div className="loading-lorry-selector-grid">
                  {LOADING_PANEL_CONFIG.map((panel) => (
                    <button
                      key={`loading-selector-${panel.name}`}
                      type="button"
                      className={`loading-lorry-selector-card${selectedLoadingPanel === panel.name ? " is-active" : ""}`}
                      onClick={() => setSelectedLoadingPanel(panel.name)}
                    >
                      {panel.name}
                    </button>
                  ))}
                </div>
              </section>
              {LOADING_PANEL_CONFIG.filter((panel) => panel.name === selectedLoadingPanel).map((panel) => {
                const rows = (sortedLoadingByLorry[panel.name] || []).filter((row) => matchesSearch(loadingsSearch, row.name, row.sku, row.size, panel.name));
                const summary = loadingSummaryByLorry[panel.name] || {};
                return (
                  <section key={panel.name} className={`admin-mobile-section loading-lorry-panel ${panel.className}`}>
                    <div className="loading-panel-head">
                      <h2>{panel.name} Loading</h2>
                      <button type="button" className="receipt-print-action" onClick={() => printLoadingBreakdown({ lorry: panel.name, rows, summary })}>Print</button>
                    </div>
                    <div className="loading-summary-grid">
                      <article><span>Ordered Qty</span><strong>{summary.orderedQty || 0}</strong></article>
                      <article><span>Ordered Value</span><strong>{currency(summary.orderedValue || 0)}</strong></article>
                      <article><span>Delivered Qty</span><strong>{summary.deliveredQty || 0}</strong></article>
                      <article><span>Delivered Value</span><strong>{currency(summary.deliveredValue || 0)}</strong></article>
                      <article className="loading-summary-accent loading-summary-bundles">
                        <span className="loading-summary-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24"><path d="M4.5 7.5 12 4l7.5 3.5L12 11z" /><path d="M4.5 7.5V16.5L12 20v-9z" /><path d="M19.5 7.5V16.5L12 20v-9z" /></svg>
                        </span>
                        <span>Ordered Bundles</span>
                        <strong>{summary.orderedBundles || 0}</strong>
                      </article>
                      <article className="loading-summary-accent loading-summary-singles">
                        <span className="loading-summary-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24"><path d="M10 3.8h4" /><path d="M11 3.8v2.1l-1.4 1.7v10.1A2.3 2.3 0 0 0 11.9 20h.2a2.3 2.3 0 0 0 2.3-2.3V7.6L13 5.9V3.8" /><path d="M9.6 10.6h4.8" /></svg>
                        </span>
                        <span>Ordered Singles</span>
                        <strong>{summary.orderedSingles || 0}</strong>
                      </article>
                      <article><span>Delivered Bundles</span><strong>{summary.deliveredBundles || 0}</strong></article>
                      <article><span>Delivered Singles</span><strong>{summary.deliveredSingles || 0}</strong></article>
                      <article className="loading-summary-status">
                        <span>Rows Loaded</span>
                        <strong>{summary.loadedRows || 0}</strong>
                      </article>
                    </div>
                    <div className="admin-table loading-table">
                      <header>
                        <button type="button" className="th-sort loading-col-item" onClick={() => toggleSort(panel.sortKey, "sku")}>SKU{sortMark(panel.sortKey, "sku")}</button>
                        <button type="button" className="th-sort loading-col-size" onClick={() => toggleSort(panel.sortKey, "size")}>Size{sortMark(panel.sortKey, "size")}</button>
                        <button type="button" className="th-sort loading-col-ordered-qty" onClick={() => toggleSort(panel.sortKey, "orderedQty")}>Ord Qty{sortMark(panel.sortKey, "orderedQty")}</button>
                        <button type="button" className="th-sort loading-col-ordered-value" onClick={() => toggleSort(panel.sortKey, "orderedValue")}>Ord Value{sortMark(panel.sortKey, "orderedValue")}</button>
                        <button type="button" className="th-sort loading-col-bundles" onClick={() => toggleSort(panel.sortKey, "bundles")}>Bundles{sortMark(panel.sortKey, "bundles")}</button>
                        <button type="button" className="th-sort loading-col-singles" onClick={() => toggleSort(panel.sortKey, "singles")}>Singles{sortMark(panel.sortKey, "singles")}</button>
                        <button type="button" className="th-sort loading-col-delivered-qty" onClick={() => toggleSort(panel.sortKey, "deliveredQty")}>Del Qty{sortMark(panel.sortKey, "deliveredQty")}</button>
                        <button type="button" className="th-sort loading-col-delivered-value" onClick={() => toggleSort(panel.sortKey, "deliveredValue")}>Del Value{sortMark(panel.sortKey, "deliveredValue")}</button>
                        <button type="button" className="th-sort loading-col-status" onClick={() => toggleSort(panel.sortKey, "loaded")}>Loaded{sortMark(panel.sortKey, "loaded")}</button>
                      </header>
                      {rows.length ? rows.map((row) => (
                        <article key={`${panel.name}-${row.key}`} className={row.loaded ? "is-loaded" : ""}>
                          <span className="loading-col-item">{row.sku || "-"}</span>
                          <span className="loading-col-size">{row.size || "-"}</span>
                          <span className="loading-col-ordered-qty">{row.orderedQty}</span>
                          <span className="loading-col-ordered-value">{currency(row.orderedValue)}</span>
                          <span className="loading-col-bundles">{row.bundles}</span>
                          <span className="loading-col-singles">{row.balance}</span>
                          <span className="loading-col-delivered-qty">{row.deliveredQty}</span>
                          <span className="loading-col-delivered-value">{currency(row.deliveredValue)}</span>
                          <span className="loading-col-status">
                            <button
                              type="button"
                              className={`loading-mark-btn${row.loaded ? " is-loaded" : ""}`}
                              onClick={() => handleToggleLoadingRow(row)}
                              disabled={loadingMarkPendingKey === row.markKey}
                            >
                              {loadingMarkPendingKey === row.markKey ? "Saving..." : row.loaded ? "Loaded ?" : "Mark Loaded"}
                            </button>
                          </span>
                        </article>
                      )) : <p>No loading data for {panel.name}.</p>}
                    </div>
                  </section>
                );
              })}
            </div>
      ) : null}
        </section>
      </main>

      {showCustomerForm ? (
        <div className="low-stock-modal" onClick={() => setShowCustomerForm(false)}>
          <div className="low-stock-modal-card customer-entry-modal" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>{customerForm.id ? "Edit Customer" : "Add Customer"}</h3>
              <button type="button" onClick={() => setShowCustomerForm(false)}>Close</button>
            </div>
            <div className="admin-inline-form customer-entry-grid">
              <label className="customer-entry-field">
                <span>Customer Name</span>
                <input value={customerForm.name} onChange={(e) => setCustomerForm((c) => ({ ...c, name: e.target.value }))} placeholder="Customer name" />
              </label>
              <label className="customer-entry-field">
                <span>Phone</span>
                <input value={customerForm.phone} onChange={(e) => setCustomerForm((c) => ({ ...c, phone: e.target.value }))} placeholder="Phone" />
              </label>
              <label className="customer-entry-field">
                <span>Opening Outstanding (LKR)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={customerForm.openingOutstanding}
                  onChange={(e) => setCustomerForm((c) => ({ ...c, openingOutstanding: e.target.value }))}
                  placeholder="Opening Outstanding (LKR)"
                  disabled={!canManageCustomerOpeningOutstanding}
                />
              </label>
              <label className="customer-entry-field">
                <span>Credit Limit (LKR)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={customerForm.creditLimit}
                  onChange={(e) => setCustomerForm((c) => ({ ...c, creditLimit: e.target.value }))}
                  placeholder="Credit Limit (LKR)"
                  disabled={!canManageCustomerLimits}
                />
              </label>
              <label className="customer-entry-field">
                <span>Discount Limit (LKR)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={customerForm.discountLimit}
                  onChange={(e) => setCustomerForm((c) => ({ ...c, discountLimit: e.target.value }))}
                  placeholder="Discount Limit (LKR)"
                  disabled={!canManageCustomerLimits}
                />
              </label>
              <label className="customer-entry-field">
                <span>Bundle Discount Limit / Bundle (LKR)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={customerForm.bundleDiscountLimit}
                  onChange={(e) => setCustomerForm((c) => ({ ...c, bundleDiscountLimit: e.target.value }))}
                  placeholder="Bundle Discount Limit / Bundle (LKR)"
                  disabled={!canManageCustomerLimits}
                />
              </label>
              <label className="customer-entry-field">
                <span>Outstanding Reduction / Write-off (LKR)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={customerForm.outstandingAdjustment}
                  onChange={(e) => setCustomerForm((c) => ({ ...c, outstandingAdjustment: e.target.value }))}
                  placeholder="Outstanding Reduction / Write-off (LKR)"
                  disabled={!canManageOutstandingAdjustment}
                />
              </label>
              <label className="customer-entry-field">
                <span>Reduction Reason</span>
                <input
                  value={customerForm.outstandingAdjustmentReason}
                  onChange={(e) => setCustomerForm((c) => ({ ...c, outstandingAdjustmentReason: e.target.value }))}
                  placeholder="Reason for reducing outstanding"
                  disabled={!canManageOutstandingAdjustment}
                />
              </label>
              {!canManageCustomerLimits ? (
                <p className="form-hint customer-form-lock-note">Manager limited access cannot edit customer details. Enable full access to unlock customer editing.</p>
              ) : null}
              {!canManageOutstandingAdjustment ? (
                <p className="form-hint customer-form-lock-note">Only admin can reduce or write off total outstanding.</p>
              ) : null}
              <label className="customer-entry-field customer-entry-field-full">
                <span>Address</span>
                <textarea value={customerForm.address} onChange={(e) => setCustomerForm((c) => ({ ...c, address: e.target.value }))} placeholder="Address" />
              </label>
              <div className="customer-entry-actions">
                <button type="button" onClick={saveCustomer}>Save Customer</button>
                <button type="button" className="ghost" onClick={() => setShowCustomerForm(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {stockSummaryDetailMode ? (
        <div className="low-stock-modal" onClick={() => setStockSummaryDetailMode("")}>
          <div className="low-stock-modal-card stock-summary-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>
                {stockSummaryDetailMode === "low"
                  ? "Low Stock Details"
                  : stockSummaryDetailMode === "out"
                    ? "Out of Stock Details"
                    : "Total Bundles Breakdown"}
              </h3>
              <button type="button" onClick={() => setStockSummaryDetailMode("")}>Close</button>
            </div>
            <p className="stock-summary-detail-note">
              Based on the current filtered stock list. Review SKU and current units clearly before taking action.
            </p>
            <div className="stock-summary-detail-list">
              {stockSummaryDetailRows.length ? stockSummaryDetailRows.map((item) => (
                <article key={`stock-summary-${item.id}`} className="stock-summary-detail-row">
                  <div className="stock-summary-detail-main">
                    <strong>{item.name}</strong>
                    <span>{item.sku || "-"}</span>
                  </div>
                  <div className="stock-summary-detail-side">
                    <span>{stockSummaryDetailMode === "bundles" ? "Total Bundles" : "Current Units"}</span>
                    <strong>{stockSummaryDetailMode === "bundles" ? Number(item.totalBundles || 0) : Number(item.stock || 0)}</strong>
                  </div>
                </article>
              )) : (
                <p className="stock-summary-detail-empty">No matching stock rows in the current filtered list.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {repOutstandingDetailRep ? (
        <div className="low-stock-modal" onClick={() => setRepOutstandingDetailRep("")}>
          <div className="low-stock-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>{repOutstandingDetailRep} Customer Outstanding</h3>
              <div className="modal-head-actions">
                <button
                  type="button"
                  className="receipt-print-action"
                  onClick={() => printRepOutstandingCustomers({ rep: repOutstandingDetailRep, rows: repOutstandingDetailRows })}
                >
                  Print
                </button>
                <button type="button" onClick={() => setRepOutstandingDetailRep("")}>Close</button>
              </div>
            </div>
            <div className="admin-table rep-outstanding-table" style={{ marginTop: "0.75rem" }}>
              <header>
                <span>Customer</span>
                <span>Bills</span>
                <span>Outstanding (LKR)</span>
                <span>Days Left</span>
              </header>
              {repOutstandingDetailRows.length ? repOutstandingDetailRows.map((row) => (
                <article key={`rep-out-detail-${repOutstandingDetailRep}-${row.customerName}`}>
                  <span>{row.customerName}</span>
                  <span>{row.bills}</span>
                  <span className="outstanding-text">{formatLkrValue(row.outstanding)}</span>
                  <span className={String(row.daysLabel || "").toLowerCase().includes("overdue") ? "outstanding-text" : ""}>{row.daysLabel || "-"}</span>
                </article>
              )) : <p>No outstanding customers for this rep in the selected range.</p>}
            </div>
          </div>
        </div>
      ) : null}

      {customerDetailData ? (
        <div className="low-stock-modal" onClick={() => setCustomerDetailName("")}>
          <div className="low-stock-modal-card customer-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>{customerDetailData.row.name}</h3>
              <button type="button" onClick={() => setCustomerDetailName("")}>Close</button>
            </div>
            <div className="customer-detail-grid">
              <article>
                <span>Total Bills</span>
                <strong>{customerDetailData.totalBills}</strong>
              </article>
              <article>
                <span>Total Spent (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.row.spent || 0)}</strong>
              </article>
              <article>
                <span>Available Credit (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.availableCredit || 0)}</strong>
              </article>
              <article>
                <span>Credit Limit (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.row.creditLimit || 0)}</strong>
              </article>
              <article>
                <span>Discount Limit (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.row.discountLimit || 0)}</strong>
              </article>
              <article>
                <span>Bundle Discount / Bundle (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.row.bundleDiscountLimit || 0)}</strong>
              </article>
              <article>
                <span>Opening Outstanding (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.openingOutstanding || 0)}</strong>
              </article>
              <article>
                <span>Outstanding Reduction (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.outstandingAdjustment || 0)}</strong>
              </article>
              <article>
                <span>Reduction Reason</span>
                <strong>{customerDetailData.outstandingAdjustmentReason || "-"}</strong>
              </article>
              <article className={Number(customerDetailData.row.outstanding || 0) > 0 ? "warn" : ""}>
                <span>Outstanding (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.row.outstanding || 0)}</strong>
              </article>
              <article>
                <span>Bill Outstanding (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.liveSaleOutstanding || 0)}</strong>
              </article>
              <article>
                <span>Total Item Qty</span>
                <strong>{customerDetailData.totalQty}</strong>
              </article>
              <article>
                <span>Returned Qty</span>
                <strong>{customerDetailData.returnedQty}</strong>
              </article>
              <article>
                <span>Returned Value (LKR)</span>
                <strong>{formatLkrValue(customerDetailData.returnedValue || 0)}</strong>
              </article>
              <article>
                <span>Average Bill Value</span>
                <strong>LKR {formatLkrValue(customerDetailData.averageBillValue || 0)}</strong>
              </article>
              <article>
                <span>Last Purchase</span>
                <strong>{customerDetailData.lastSaleAt ? new Date(customerDetailData.lastSaleAt).toLocaleDateString() : "-"}</strong>
              </article>
            </div>
            <div className="customer-detail-meta">
              <p><strong>Phone:</strong> {customerDetailData.row.phone || "-"}</p>
              <p><strong>Address:</strong> {customerDetailData.row.address || "-"}</p>
            </div>
            <div className="customer-detail-recent">
              <h4>Recent Bills</h4>
              {customerDetailData.recentSales.length ? (
                <div className="customer-detail-recent-list">
                  {customerDetailData.recentSales.map((sale) => (
                    <article key={sale.id}>
                      <span>#{sale.id}</span>
                      <span>{new Date(sale.createdAt).toLocaleDateString()}</span>
                      <strong>{currency(saleNetTotal(sale))}</strong>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="form-hint">No recent sales found.</p>
              )}
            </div>
            <div className="customer-detail-actions">
              <button
                type="button"
                onClick={() => {
                  openCustomerEditByRow(customerDetailData.row);
                  setCustomerDetailName("");
                }}
              >
                Edit Customer
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editingAdminSaleId ? (
        <div className="low-stock-modal" onClick={() => { setEditingAdminSaleId(""); setAdminSaleEditLines([]); setAdminSaleEditError(""); }}>
          <div className="low-stock-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Edit Sale #{editingAdminSaleId}</h3>
              <button type="button" onClick={() => { setEditingAdminSaleId(""); setAdminSaleEditLines([]); setAdminSaleEditError(""); }}>Close</button>
            </div>
            <div className="admin-inline-form">
              {adminSaleEditLines.map((line) => (
                <div key={line.productId} className="stock-row">
                  <span>{line.name}</span>
                  <input type="number" min="1" value={line.quantity} onChange={(e) => setAdminSaleEditLines((current) => current.map((l) => (l.productId === line.productId ? { ...l, quantity: e.target.value } : l)))} />
                  <button type="button" className="row-danger" onClick={() => setAdminSaleEditLines((current) => current.filter((l) => l.productId !== line.productId))}>Remove</button>
                </div>
              ))}
              {adminSaleEditError ? <p className="form-hint">{adminSaleEditError}</p> : null}
              <div>
                <button type="button" onClick={saveAdminSaleEdit} disabled={savingAdminSaleEdit}>{savingAdminSaleEdit ? "Saving..." : "Save Edit"}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {viewedSale ? (
        <div className="low-stock-modal" onClick={() => setViewSaleId("")}>
          <div className="low-stock-modal-card receipt-preview-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Receipt #{viewedSale.id}</h3>
              <div className="receipt-preview-head-actions">
                <button type="button" className="receipt-print-action" onClick={() => printAdminSaleReceipt(viewedSale)}>Print</button>
                <button type="button" className="ghost" onClick={() => setViewSaleId("")}>Close</button>
              </div>
            </div>
            <div className="receipt-preview">
              <h4>M.W.M.B CHANDRASEKARA - MATALE DISTRIBUTOR</h4>
              <p>{new Date(viewedSale.createdAt).toLocaleString()} • {viewedSale.customerName} • {viewedSale.lorry || "-"} • {viewedSale.cashier || "-"} • {viewedSalePaymentDisplay.label}{viewedSalePaymentDisplay.detail ? ` (${viewedSalePaymentDisplay.detail})` : ""}</p>
              <div className="admin-table receipt-table">
                <header>
                  <span>Item Code</span>
                  <span>Qty</span>
                  <span>Price<br />LKR</span>
                  <span>Item Discount</span>
                  <span>Total<br />LKR</span>
                </header>
                  {(viewedSale.lines || []).map((line) => {
                    const returned = viewedSaleReturnByProduct.get(String(line.productId || "")) || { qty: 0, amount: 0 };
                    const notDeliveredQty = Number(viewedSaleUndeliveredByProduct.get(String(line.productId || "")) || 0);
                    const originalQty = Number(line.quantity || 0);
                    const soldAfterDelivery = Math.max(0, originalQty - notDeliveredQty);
                    const netQty = Math.max(0, soldAfterDelivery - Number(returned.qty || 0));
                    const bundleSource = productInfoById.get(line.productId) || line;
                    const bundleSize = getBundleSize(bundleSource);
                    const bundles = bundleSize ? Math.floor(netQty / bundleSize) : 0;
                    const singles = bundleSize ? netQty % bundleSize : netQty;
                    const grossRemaining = Number((Number(line.price || 0) * netQty).toFixed(2));
                    const remainingBillDiscountShare = Number(viewedSale.subTotal || 0) > 0
                      ? Number((Number(viewedSale.discountAmount || viewedSale.discount || 0) * (grossRemaining / Number(viewedSale.subTotal || 1))).toFixed(2))
                      : 0;
                    const netLineAmount = Math.max(0, Number((grossRemaining - remainingBillDiscountShare).toFixed(2)));
                    return (
                      <article key={`${viewedSale.id}-${line.productId}`}>
                        <span>
                          {line.sku || productInfoById.get(line.productId)?.sku || "-"}
                          {notDeliveredQty > 0 ? <small className="sales-return-note">Not Delivered {notDeliveredQty}</small> : null}
                          {Number(returned.qty || 0) > 0 ? <small className="sales-return-note">Returned {returned.qty}</small> : null}
                        </span>
                        <span>
                          {netQty}
                          {bundleSize > 0 ? <small className="sales-return-note">{bundles} Bundles {singles} Singles</small> : null}
                        </span>
                        <span>{formatLkrValue(line.price || 0)}</span>
                        <span>
                          {Number(line.itemDiscount || 0) > 0 ? currency(line.itemDiscount) : "-"}
                          {remainingBillDiscountShare > 0 ? <small className="sales-return-note">Bill disc. {formatLkrValue(remainingBillDiscountShare)}</small> : null}
                        </span>
                        <span>
                          {formatLkrValue(netLineAmount || 0)}
                          {Number(returned.amount || 0) > 0 ? <small className="sales-return-note">- {formatLkrValue(returned.amount)}</small> : null}
                        </span>
                      </article>
                    );
                  })}
                </div>
                <div className="receipt-summary-row">
                  <div className="receipt-summary-texts">
                    <p className="form-hint">Discount: {currency(viewedSale.discount || 0)}</p>
                    {viewedSaleReturnedAmount > 0 ? <p className="form-hint return-adjust-text">Returns: - {currency(viewedSaleReturnedAmount)}</p> : null}
                    <p className="form-hint"><strong>Total: {currency(viewedSaleNetAmount || 0)}</strong></p>
                  </div>
                </div>
            </div>
          </div>
        </div>
      ) : null}

      {deliverySale ? (
        <div className="low-stock-modal" onClick={() => { setDeliverySaleId(""); setDeliveryDraft({}); setDeliveryCashReceived(""); setDeliveryChequeAmount(""); setDeliveryChequeNo(""); setDeliveryChequeDate(""); setDeliveryChequeBank(""); setDeliveryError(""); }}>
          <div className="low-stock-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Confirm Delivery #{deliverySale.id}</h3>
              <button type="button" onClick={() => { setDeliverySaleId(""); setDeliveryDraft({}); setDeliveryCashReceived(""); setDeliveryChequeAmount(""); setDeliveryChequeNo(""); setDeliveryChequeDate(""); setDeliveryChequeBank(""); setDeliveryError(""); }}>Close</button>
            </div>
            <p className="form-hint">{new Date(deliverySale.createdAt).toLocaleString()} • {deliverySale.customerName || "Walk-in"} • {deliverySale.cashier || "-"} • {deliverySale.lorry || "-"}</p>
            <div className="admin-table deliveries-lines-table">
              <header>
                <span>Item</span>
                <span>Sold</span>
                <span>Already ND</span>
                <span>Not Delivered</span>
              </header>
              {(deliverySale.lines || []).map((line) => {
                const prevUndelivered = (deliverySale.deliveryAdjustments || [])
                  .reduce((acc, adj) => acc + (adj.lines || [])
                    .filter((x) => x.productId === line.productId)
                    .reduce((xAcc, x) => xAcc + Number(x.quantity || 0), 0), 0);
                const prevReturnedGood = (state.returns || [])
                  .filter((ret) => String(ret.saleId) === String(deliverySale.id))
                  .reduce((acc, ret) => acc + (ret.lines || [])
                    .filter((x) => x.productId === line.productId && String(x.condition || "").toLowerCase() === "good")
                    .reduce((xAcc, x) => xAcc + Number(x.quantity || 0), 0), 0);
                const maxQty = Math.max(0, Number(line.quantity || 0) - prevUndelivered - prevReturnedGood);
                return (
                  <article key={`dl-${deliverySale.id}-${line.productId}`}>
                    <span>{line.name}</span>
                    <span>{line.quantity}</span>
                    <span>{prevUndelivered}</span>
                    <span>
                      <input
                        type="number"
                        min="0"
                        max={maxQty}
                        value={deliveryDraft[line.productId] ?? ""}
                        onChange={(e) => onDeliveryDraftChange(line.productId, e.target.value)}
                        placeholder={`max ${maxQty}`}
                        disabled={Boolean(deliverySale.deliveryConfirmedAt)}
                      />
                    </span>
                  </article>
                );
              })}
            </div>
              <div className="delivery-settlement-panel">
                  <div className="delivery-settlement-head">
                    <div>
                      <h4>Settlement At Delivery</h4>
                    <p>Collect the delivery payment clearly before confirming this bill.</p>
                    </div>
                    <span className={`rep-sale-payment rep-sale-payment-${String(deliverySale.paymentType || "").toLowerCase()}`}>{deliverySale.paymentType}</span>
                  </div>
                <div className="delivery-settlement-kpis">
                  <article>
                    <span>Order Total</span>
                    <strong>{currency(deliverySale.total || 0)}</strong>
                  </article>
                  <article>
                    <span>Paid So Far</span>
                    <strong>{currency(deliveryPaidSoFar)}</strong>
                  </article>
                  <article className="active">
                    <span>This Update</span>
                    <strong>{currency(deliveryDraftSettlement)}</strong>
                  </article>
                  <article className="warn">
                    <span>Balance After</span>
                    <strong>{currency(deliveryRemainingAfterDraft)}</strong>
                  </article>
                </div>
                <div className="delivery-settlement-grid">
                <label className="rep-sale-field">
                  <span>Cash Received</span>
                  <input type="number" min="0" step="0.01" value={deliveryCashReceived} onChange={(e) => setDeliveryCashReceived(e.target.value)} placeholder="0.00" />
                </label>
                <label className="rep-sale-field">
                  <span>Cheque Amount</span>
                  <input type="number" min="0" step="0.01" value={deliveryChequeAmount} onChange={(e) => setDeliveryChequeAmount(e.target.value)} placeholder="0.00" />
                </label>
                <label className="rep-sale-field">
                  <span>Cheque No</span>
                  <input value={deliveryChequeNo} onChange={(e) => setDeliveryChequeNo(e.target.value)} placeholder="Cheque number" />
                </label>
                <label className="rep-sale-field">
                  <span>Cheque Date</span>
                  <input type="date" value={deliveryChequeDate} onChange={(e) => setDeliveryChequeDate(e.target.value)} />
                </label>
                <label className="rep-sale-field delivery-settlement-bank">
                  <span>Bank</span>
                  <input value={deliveryChequeBank} onChange={(e) => setDeliveryChequeBank(e.target.value)} placeholder="Bank name" />
                </label>
              </div>
              </div>
            <div className="delivery-history delivery-payment-history">
              <h4>Payment History</h4>
              {deliveryPaymentRows.length ? (
                <div className="delivery-history-list">
                  {deliveryPaymentRows.map((payment) => (
                    <article key={payment.id} className="delivery-history-row">
                      <p>
                        <strong>{String(payment.method || "").toUpperCase()}</strong>
                        {" • "}
                        {currency(payment.amount || 0)}
                        {" • "}
                        {new Date(payment.createdAt).toLocaleString()}
                      </p>
                      <p>
                        {payment.method === "cheque"
                          ? `Cheque No: ${payment.chequeNo || "-"} | Date: ${payment.chequeDate || "-"} | Bank: ${payment.chequeBank || "-"}`
                          : `Received by: ${payment.receivedBy || "-"}`
                        }
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="form-hint">No payment collected yet.</p>
              )}
            </div>
            <div className="delivery-history">
              <h4>Delivery History</h4>
              {(deliverySale.deliveryAdjustments || []).length ? (
                <div className="delivery-history-list">
                  {deliverySale.deliveryAdjustments.map((adj) => (
                    <article key={adj.id} className="delivery-history-row">
                      <p>
                        <strong>{new Date(adj.createdAt).toLocaleString()}</strong>
                        {" • "}
                        {adj.by || "admin"}
                      </p>
                      <p>
                        {(adj.lines || []).map((line) => `${line.name}: ${line.quantity}`).join(" | ")}
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="form-hint">No previous delivery adjustments.</p>
              )}
            </div>
            {deliveryError ? <p className="form-hint">{deliveryError}</p> : null}
            <div className="admin-page-actions">
              <button type="button" onClick={saveDeliveryAdjust} disabled={savingDelivery}>
                {savingDelivery ? "Saving..." : (deliverySale.deliveryConfirmedAt ? "Save Payment Update" : "Confirm Delivery")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showLowStock ? (
        <div className="low-stock-modal" onClick={() => setShowLowStock(false)}>
          <div className="low-stock-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Low Stock List</h3>
              <button type="button" onClick={() => setShowLowStock(false)}>Close</button>
            </div>
            <div className="low-stock-modal-list">
              {dashboard.lowStockItems.length ? dashboard.lowStockItems.map((item) => (
                <article key={item.id} className="list-row">
                  <div>
                    <strong>{item.name}</strong>
                    <p>{item.sku} • {item.category}</p>
                  </div>
                  <strong>{item.stock}</strong>
                </article>
              )) : <p>No low stock items.</p>}
            </div>
          </div>
        </div>
      ) : null}

      {showChequeAlertDetails ? (
        <div className="low-stock-modal" onClick={() => setShowChequeAlertDetails(false)}>
          <div className="low-stock-modal-card cheque-alert-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Tomorrow Cheques</h3>
              <button type="button" onClick={() => setShowChequeAlertDetails(false)}>Close</button>
            </div>
            <p className="form-hint">
              {upcomingChequeSummary.count} cheque{upcomingChequeSummary.count === 1 ? "" : "s"} due on {upcomingChequeSummary.date} • Total LKR {formatLkrValue(upcomingChequeSummary.total)}
            </p>
            <div className="admin-table cheque-alert-table">
              <header>
                <span>Sale</span>
                <span>Customer</span>
                <span>Amount</span>
                <span>Cheque No</span>
                <span>Bank</span>
                <span>Rep</span>
              </header>
              {upcomingChequeSummary.rows.map((row) => (
                <article key={`cheque-alert-${row.saleId}-${row.chequeNo}-${row.customer}`}>
                  <span>#{row.saleId}</span>
                  <span>{row.customer}</span>
                  <span>LKR {formatLkrValue(row.amount)}</span>
                  <span>{row.chequeNo}</span>
                  <span>{row.bank}</span>
                  <span>{row.rep}</span>
                </article>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {showChequeSummaryDetails ? (
        <div className="low-stock-modal" onClick={() => setShowChequeSummaryDetails(false)}>
          <div className="low-stock-modal-card cheque-alert-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Cheque Details</h3>
              <button type="button" onClick={() => setShowChequeSummaryDetails(false)}>Close</button>
            </div>
            <p className="form-hint">
              {chequeReportSummary.chequeCount} cheque{chequeReportSummary.chequeCount === 1 ? "" : "s"} • Total LKR {formatLkrValue(chequeReportSummary.totalChequeAmount)}
            </p>
            <div className="admin-table cheque-alert-table cheque-summary-details-table">
              <header>
                <button type="button" className="th-sort" onClick={() => toggleSort("chequeSummary", "saleId")}>Sale{sortMark("chequeSummary", "saleId")}</button>
                <button type="button" className="th-sort" onClick={() => toggleSort("chequeSummary", "date")}>Date{sortMark("chequeSummary", "date")}</button>
                <button type="button" className="th-sort" onClick={() => toggleSort("chequeSummary", "customer")}>Customer{sortMark("chequeSummary", "customer")}</button>
                <button type="button" className="th-sort" onClick={() => toggleSort("chequeSummary", "amount")}>Amount{sortMark("chequeSummary", "amount")}</button>
                <button type="button" className="th-sort" onClick={() => toggleSort("chequeSummary", "chequeNo")}>Cheque No{sortMark("chequeSummary", "chequeNo")}</button>
                <button type="button" className="th-sort" onClick={() => toggleSort("chequeSummary", "chequeDate")}>Cheque Date{sortMark("chequeSummary", "chequeDate")}</button>
                <button type="button" className="th-sort" onClick={() => toggleSort("chequeSummary", "bank")}>Bank{sortMark("chequeSummary", "bank")}</button>
                <button type="button" className="th-sort" onClick={() => toggleSort("chequeSummary", "rep")}>Rep{sortMark("chequeSummary", "rep")}</button>
              </header>
              {sortedChequeSummaryRows.length ? sortedChequeSummaryRows.map((row) => (
                <article key={`cheque-summary-${row.rowId}`}>
                  <span>#{row.saleId}</span>
                  <span>{row.date}</span>
                  <span>{row.customer}</span>
                  <span>LKR {formatLkrValue(row.amount)}</span>
                  <span>{row.chequeNo}</span>
                  <span>{row.chequeDate}</span>
                  <span>{row.bank}</span>
                  <span>{row.rep}</span>
                </article>
              )) : <p>No cheque records in selected range.</p>}
            </div>
          </div>
        </div>
      ) : null}

      {showCreditLimitAlertDetails ? (
        <div className="low-stock-modal" onClick={() => setShowCreditLimitAlertDetails(false)}>
          <div className="low-stock-modal-card cheque-alert-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Credit Limit Notifications</h3>
              <button type="button" onClick={() => setShowCreditLimitAlertDetails(false)}>Close</button>
            </div>
            <p className="form-hint">
              {creditLimitAlertSummary.count
                ? `${creditLimitAlertSummary.count} customer${creditLimitAlertSummary.count === 1 ? "" : "s"} exceeded the assigned credit limit. Total over limit: LKR ${formatLkrValue(creditLimitAlertSummary.totalExceeded)}`
                : "No customer is above the assigned credit limit."}
            </p>
            <div className="credit-limit-alert-list">
              {creditLimitAlertSummary.rows.length ? creditLimitAlertSummary.rows.map((row) => (
                <article className="credit-limit-alert-item" key={`credit-limit-alert-${row.customer}-${row.rep}`}>
                  <div className="credit-limit-alert-head">
                    <div>
                      <h4>{row.customer}</h4>
                      <p>{row.phone && row.phone !== "-" ? row.phone : "No phone number"}</p>
                    </div>
                    <div className="credit-limit-alert-tags">
                      <span className="credit-limit-alert-rep">{row.rep && row.rep !== "-" ? row.rep : "No rep linked"}</span>
                      <span className={`credit-limit-alert-days ${String(row.daysLabel || "").toLowerCase().includes("overdue") ? "is-overdue" : ""}`}>{row.daysLabel || "-"}</span>
                    </div>
                  </div>
                  <div className="credit-limit-alert-metrics">
                    <div>
                      <span>Outstanding</span>
                      <strong>LKR {formatLkrValue(row.outstanding)}</strong>
                    </div>
                    <div>
                      <span>Credit Limit</span>
                      <strong>LKR {formatLkrValue(row.creditLimit)}</strong>
                    </div>
                    <div className="credit-limit-alert-over">
                      <span>Exceeded By</span>
                      <strong>LKR {formatLkrValue(row.exceededBy)}</strong>
                    </div>
                  </div>
                </article>
              )) : <p className="credit-limit-alert-empty">No credit limit notifications right now.</p>}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};

export const App = () => {
  const [state, setState] = useState({ settings: {}, products: [], sales: [], returns: [] });
  const [dashboard, setDashboard] = useState({ salesCount: 0, todaySalesCount: 0, todayRevenue: 0, todayOutstanding: 0, lowStockItems: [] });
  const [appConfig, setAppConfig] = useState({ appMode: "live", demo: { enabled: false, readOnly: false, hasSnapshot: false } });
  const [search, setSearch] = useState("");
  const [cashier, setCashier] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [lorry, setLorry] = useState("");
  const [paymentType, setPaymentType] = useState(PAYMENT_TYPES[0]);
  const [cashReceived, setCashReceived] = useState("");
  const [creditDueDate, setCreditDueDate] = useState("");
  const [chequeAmount, setChequeAmount] = useState("");
  const [chequeNo, setChequeNo] = useState("");
  const [chequeDate, setChequeDate] = useState("");
  const [chequeBank, setChequeBank] = useState("");
  const [discountMode, setDiscountMode] = useState("amount");
  const [discountValue, setDiscountValue] = useState("");
  const [customerCreditDraft, setCustomerCreditDraft] = useState("");
  const [cart, setCart] = useState([]);
  const [message, setMessage] = useState("");
  const [savingCheckout, setSavingCheckout] = useState(false);
  const [errorModal, setErrorModal] = useState("");
  const [successModal, setSuccessModal] = useState("");
  const [confirmModal, setConfirmModal] = useState(null);
  const [authError, setAuthError] = useState("");
  const [session, setSession] = useState(null);
  const [cashierBillingFocusMode, setCashierBillingFocusMode] = useState(false);
  const confirmResolverRef = useRef(null);

  const showErrorModal = (text) => {
    const value = String(text || "").trim();
    setMessage("");
    setErrorModal(value || "Something went wrong.");
  };

  const showSuccessModal = (text) => {
    const value = String(text || "").trim();
    setMessage("");
    setSuccessModal(value || "Done.");
  };

  const requestConfirm = ({ title = "Confirm Delete", message = "Are you sure want to delete?", confirmLabel = "Delete", cancelLabel = "Cancel", tone = "danger" } = {}) =>
    new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmModal({ title, message, confirmLabel, cancelLabel, tone });
    });

  const resolveConfirm = (accepted) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmModal(null);
    if (typeof resolver === "function") resolver(Boolean(accepted));
  };

  const taxRate = 0;
  const effectiveCartLines = useMemo(
    () => cart.map((line) => ({ ...line, itemDiscount: lineItemDiscount(line), price: lineFinalPrice(line) })),
    [cart]
  );
  const discountAmount = useMemo(() => billDiscountValue(discountMode, discountValue, effectiveCartLines), [effectiveCartLines, discountMode, discountValue]);
  const totals = useMemo(() => calculateTotals({ lines: effectiveCartLines, taxRate, discount: discountAmount }), [effectiveCartLines, taxRate, discountAmount]);
const selectedBillingCustomer = useMemo(() => {
    const key = String(customerName || "").trim().toLowerCase();
    if (!key) return null;
    const matches = (state.customers || []).filter((item) => String(item.name || "").trim().toLowerCase() === key);
    if (!matches.length) return null;
    return matches.reduce((merged, item) => ({
      ...(merged || {}),
      ...item,
      discountLimit: Math.max(Number(merged?.discountLimit || 0), Number(item.discountLimit || 0)),
      bundleDiscountLimit: Math.max(Number(merged?.bundleDiscountLimit || 0), Number(item.bundleDiscountLimit || 0))
    }), null);
  }, [customerName, state.customers]);
  const selectedCustomerDiscountLimit = useMemo(() => Number(selectedBillingCustomer?.discountLimit || 0), [selectedBillingCustomer?.discountLimit]);
  const selectedCustomerBundleDiscountLimit = useMemo(() => Number(selectedBillingCustomer?.bundleDiscountLimit || 0), [selectedBillingCustomer?.bundleDiscountLimit]);
  const cartDiscountTotal = useMemo(() => totalDiscountApplied({ lines: effectiveCartLines, billDiscount: discountAmount }), [effectiveCartLines, discountAmount]);
  const customerCreditMap = useMemo(() => {
    const map = new Map();
    for (const entry of (state.customerCredits || [])) {
      const key = String(entry.customerName || "").trim();
      if (!key) continue;
      const remaining = Number(entry.remainingAmount ?? entry.amount ?? 0);
      if (remaining <= 0) continue;
      map.set(key, Number(map.get(key) || 0) + remaining);
    }
    return map;
  }, [state.customerCredits]);
  const selectedCustomerAvailableCredit = useMemo(() => {
    const key = String(customerName || "").trim();
    if (!key) return 0;
    return Number(customerCreditMap.get(key) || 0);
  }, [customerName, customerCreditMap]);
  const appliedCustomerCredit = useMemo(() => {
    const requested = Number(customerCreditDraft || 0);
    if (!Number.isFinite(requested) || requested <= 0) return 0;
    return Number(Math.max(0, Math.min(requested, selectedCustomerAvailableCredit, Number(totals.total || 0))).toFixed(2));
  }, [customerCreditDraft, selectedCustomerAvailableCredit, totals.total]);
  const totalAfterCustomerCredit = useMemo(
    () => Number(Math.max(0, Number(totals.total || 0) - appliedCustomerCredit).toFixed(2)),
    [totals.total, appliedCustomerCredit]
  );
  const currentCartQty = useMemo(
    () => effectiveCartLines.reduce((acc, line) => acc + Number(line.quantity || 0), 0),
    [effectiveCartLines]
  );
  const lorryLoadMap = useMemo(() => {
    const next = ORDER_LORRIES.reduce((acc, name) => {
      acc[name] = 0;
      return acc;
    }, {});
    const resetAtMap = state?.settings?.lorryCountResetAt || {};
    for (const sale of (state.sales || [])) {
      const lorryName = String(sale.lorry || "").trim();
      if (!(lorryName in next)) continue;
      if (!BASE_LORRIES.includes(lorryName) && sale.deliveryConfirmedAt) continue;
      const resetAt = String(resetAtMap[lorryName] || "").trim();
      if (resetAt) {
        const saleCreatedAtTs = new Date(sale.createdAt || 0).getTime();
        const resetAtTs = new Date(resetAt).getTime();
        if (Number.isFinite(saleCreatedAtTs) && Number.isFinite(resetAtTs) && saleCreatedAtTs <= resetAtTs) {
          continue;
        }
      }
      const soldQty = (sale.lines || []).reduce((acc, line) => acc + Number(line.quantity || 0), 0);
      next[lorryName] += soldQty;
    }
    return next;
  }, [state.sales, state?.settings?.lorryCountResetAt]);

  useEffect(() => {
    const handleInvalidSession = () => {
      sessionStorage.removeItem(SESSION_KEY);
      setSession(null);
      setAuthError("Session expired. Please sign in again.");
    };

    setAuthCallbacks({
      onRefresh: (nextSession) => {
        setSession(nextSession);
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
      },
      onInvalid: handleInvalidSession
    });

    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.accessToken) {
        setAuthSession(parsed);
        setSession(parsed);
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, []);

  useEffect(() => {
    if (!customerName.trim() || selectedCustomerAvailableCredit <= 0) {
      setCustomerCreditDraft("");
      return;
    }
    const current = Number(customerCreditDraft || 0);
    if (!Number.isFinite(current) || current < 0) {
      setCustomerCreditDraft("");
      return;
    }
    if (current > selectedCustomerAvailableCredit) {
      setCustomerCreditDraft(String(selectedCustomerAvailableCredit));
    }
  }, [customerName, selectedCustomerAvailableCredit]);

  useEffect(() => {
    if (!session) return undefined;
    let mounted = true;

    const load = async () => {
      try {
        await fetchMe();
        const [freshState, freshDashboard, freshConfig] = await Promise.all([fetchState(), fetchDashboard(), fetchAppConfig()]);
        if (!mounted) return;
        setState(freshState);
        setDashboard(freshDashboard);
        setAppConfig(freshConfig || { appMode: "live", demo: { enabled: false, readOnly: false, hasSnapshot: false } });
      } catch (error) {
        if (mounted) showErrorModal(error.message);
      }
    };

    load();

    const socket = io(getApiBase(), {
      transports: ["websocket", "polling"],
      auth: { token: getAccessToken() }
    });

    socket.on(SOCKET_EVENTS.STATE_SYNC, (next) => {
      if (mounted) setState(next);
    });
    socket.on(SOCKET_EVENTS.SALE_CREATED, () => fetchDashboard().then((d) => mounted && setDashboard(d)).catch(() => {}));

    return () => {
      mounted = false;
      socket.disconnect();
    };
  }, [session?.accessToken]);

  useEffect(() => {
    if (session?.user?.role === "cashier") {
      setCashier(session.user.username || "");
    }
  }, [session?.user?.role, session?.user?.username]);

  useEffect(() => {
    if (paymentType !== "cash") setCashReceived("");
    if (paymentType !== "credit") setCreditDueDate("");
    if (paymentType !== "cheque") {
      setChequeAmount("");
      setChequeNo("");
      setChequeDate("");
      setChequeBank("");
    }
  }, [paymentType]);

  useEffect(() => {
    if (!session?.user || typeof window === "undefined") return undefined;

    const marker = { pepsiPosGuard: true, ts: Date.now() };
    window.history.pushState(marker, "", window.location.href);

    const handlePopState = () => {
      const shouldExit = window.confirm("Are you sure you want to exit?");
      if (shouldExit) {
        window.removeEventListener("popstate", handlePopState);
        window.history.back();
        return;
      }
      window.history.pushState({ pepsiPosGuard: true, ts: Date.now() }, "", window.location.href);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [session?.user]);

  const applyLocalSaleDelete = (saleId) => {
    setState((current) => {
      const targetSale = (current.sales || []).find((sale) => String(sale.id) === String(saleId));
      if (!targetSale) return current;

      const returnedByProduct = new Map();
      for (const ret of (current.returns || [])) {
        if (String(ret.saleId) !== String(saleId)) continue;
        for (const line of (ret.lines || [])) {
          returnedByProduct.set(line.productId, (returnedByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
        }
      }

      return {
        ...current,
        products: (current.products || []).map((product) => {
          const saleLine = (targetSale.lines || []).find((line) => line.productId === product.id);
          if (!saleLine) return product;
          const sold = Number(saleLine.quantity || 0);
          const alreadyReturned = Number(returnedByProduct.get(product.id) || 0);
          const netSold = Math.max(0, sold - alreadyReturned);
          return {
            ...product,
            stock: Number((Number(product.stock || 0) + netSold).toFixed(2))
          };
        }),
        sales: (current.sales || []).filter((sale) => String(sale.id) !== String(saleId)),
        returns: (current.returns || []).filter((ret) => String(ret.saleId) !== String(saleId))
      };
    });
  };

  const login = async ({ username, password }) => {
    const attempts = [
      { role: "admin", username, password },
      { role: "manager", username, password },
      { role: "cashier", username, password }
    ];
    try {
      let nextSession = null;
      for (const payload of attempts) {
        try {
          nextSession = await loginApi(payload);
          break;
        } catch {}
      }
      if (!nextSession) throw new Error("Invalid credentials");
      setAuthSession(nextSession);
      setSession(nextSession);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
      setAuthError("");
      setMessage("");
    } catch (error) {
      setAuthError(error.message);
    }
  };

  const logout = async () => {
    await logoutApi();
    clearAuthSession();
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
    setCart([]);
    setMessage("");
  };

  const createSaleRequestId = () => {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    return `sale-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  };

  const checkout = async () => {
    try {
      if (savingCheckout) return;
      setSavingCheckout(true);
      const LORRY_CAPACITY = 2880;
      const matchedCustomer = (state.customers || []).find(
        (item) => String(item.name || "").trim().toLowerCase() === String(customerName || "").trim().toLowerCase()
      );
      if (!lorry) {
        showErrorModal("Select a delivery bucket.");
        return;
      }
      const pendingLoad = Number(lorryLoadMap[lorry] || 0);
      if (BASE_LORRIES.includes(lorry)) {
        if (pendingLoad >= LORRY_CAPACITY) {
          showErrorModal("Selected lorry is full.");
          return;
        }
        if ((pendingLoad + currentCartQty) > LORRY_CAPACITY) {
          showErrorModal(`Selected lorry exceeds capacity. Only ${Math.max(0, LORRY_CAPACITY - pendingLoad)} items left.`);
          return;
        }
      }
      if (selectedCustomerDiscountLimit > 0 && cartDiscountTotal > selectedCustomerDiscountLimit) {
        showErrorModal(`Customer discount limit is ${currency(selectedCustomerDiscountLimit)}. Current discount is ${currency(cartDiscountTotal)}.`);
        return;
      }
      const bundleDiscountViolation = findBundleDiscountViolation({ lines: effectiveCartLines, bundleDiscountLimit: selectedCustomerBundleDiscountLimit });
      if (bundleDiscountViolation) {
        showErrorModal(`${bundleDiscountViolation.lineName} exceeds bundle discount limit. Allowed ${currency(bundleDiscountViolation.allowedBundleDiscount)} for ${bundleDiscountViolation.fullBundles} bundle(s).`);
        return;
      }
      const sale = await submitSale({
        requestId: createSaleRequestId(),
        cashier,
        customerName,
        customerPhone: matchedCustomer?.phone ? String(matchedCustomer.phone).trim() : undefined,
        lorry,
        paymentType,
        customerCreditAmount: appliedCustomerCredit,
        discount: discountAmount,
        taxRate: 0,
        lines: effectiveCartLines
      });
      openSaleReceiptPrint({
        sale: {
          ...sale,
          customerPhone: sale?.customerPhone || (matchedCustomer?.phone ? String(matchedCustomer.phone).trim() : "")
        },
        customers: state.customers || [],
        products: state.products || [],
        fallbackCustomerName: customerName,
        onPopupBlocked: () => showErrorModal(`Sale ${sale.id} completed, but popup is blocked. Allow popups to print receipt.`)
      });
      showSuccessModal("Order completed.");
      setCart([]);
      setShowPostSaleHomeButton(true);
      setDiscountValue("");
      setCustomerCreditDraft("");
      setCashReceived("");
      setCreditDueDate("");
      setChequeAmount("");
      setChequeNo("");
      setChequeDate("");
      setChequeBank("");
      setDashboard(await fetchDashboard());
    } catch (error) {
      showErrorModal(error.message);
    } finally {
      setSavingCheckout(false);
    }
  };

  if (!session?.user) {
    return <LoginScreen onLogin={login} error={authError} />;
  }

  return (
    <div className={`shell ${session.user.role === "cashier" && cashierBillingFocusMode ? "cashier-billing-shell" : ""}`}>
      {appConfig?.demo?.enabled ? (
        <div className="demo-mode-banner">
          DEMO MODE {appConfig?.demo?.readOnly ? "• READ ONLY" : "• EDITABLE"}
        </div>
      ) : null}
      {!(session.user.role === "cashier" && cashierBillingFocusMode) ? (
        <Header dashboard={dashboard} user={session.user} onLogout={logout} managerFullAccess={Boolean(state?.settings?.managerFullAccess)} />
      ) : null}
      {session.user.role === "cashier" ? (
        <CashierView
          state={state}
          dashboard={dashboard}
          search={search}
          setSearch={setSearch}
          cashier={cashier}
          customerName={customerName}
          setCustomerName={setCustomerName}
          lorry={lorry}
          setLorry={setLorry}
          paymentType={paymentType}
          setPaymentType={setPaymentType}
          cashReceived={cashReceived}
          setCashReceived={setCashReceived}
          creditDueDate={creditDueDate}
          setCreditDueDate={setCreditDueDate}
          chequeAmount={chequeAmount}
          setChequeAmount={setChequeAmount}
          chequeNo={chequeNo}
          setChequeNo={setChequeNo}
          chequeDate={chequeDate}
          setChequeDate={setChequeDate}
          chequeBank={chequeBank}
          setChequeBank={setChequeBank}
          discountMode={discountMode}
          setDiscountMode={setDiscountMode}
          discountValue={discountValue}
          setDiscountValue={setDiscountValue}
          selectedCustomerDiscountLimit={selectedCustomerDiscountLimit}
          selectedCustomerBundleDiscountLimit={selectedCustomerBundleDiscountLimit}
          selectedCustomerAvailableCredit={selectedCustomerAvailableCredit}
          cartDiscountTotal={cartDiscountTotal}
          customerCreditDraft={customerCreditDraft}
          setCustomerCreditDraft={setCustomerCreditDraft}
          appliedCustomerCredit={appliedCustomerCredit}
          totalAfterCustomerCredit={totalAfterCustomerCredit}
        lorryLoadMap={lorryLoadMap}
        currentCartQty={currentCartQty}
        cart={cart}
        setCart={setCart}
        totals={totals}
            message={message}
            setMessage={setMessage}
            onSaleDeleted={applyLocalSaleDelete}
            onSuccess={showSuccessModal}
            onLogout={logout}
            onBillingFocusChange={setCashierBillingFocusMode}
            requestConfirm={requestConfirm}
            savingCheckout={savingCheckout}
            checkout={checkout}
          />
      ) : (
        <AdminView
            state={state}
            dashboard={dashboard}
            message={message}
            onError={showErrorModal}
            requestConfirm={requestConfirm}
            onSaleDeleted={applyLocalSaleDelete}
            user={session.user}
        />
        )}
        {errorModal ? (
          <div className="low-stock-modal" onClick={() => setErrorModal("")}>
            <div className="low-stock-modal-card error-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="low-stock-modal-head">
              <h3>Error</h3>
              <button type="button" onClick={() => setErrorModal("")}>Close</button>
            </div>
            <p className="error-modal-text">{errorModal}</p>
            </div>
          </div>
        ) : null}
        {successModal ? (
          <div className="low-stock-modal" onClick={() => setSuccessModal("")}>
            <div className="low-stock-modal-card success-modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="low-stock-modal-head">
                <h3><span className="success-modal-icon" aria-hidden="true">?</span>Success</h3>
                <button type="button" onClick={() => setSuccessModal("")}>Close</button>
              </div>
              <p className="success-modal-text">{successModal}</p>
            </div>
          </div>
        ) : null}
        {confirmModal ? (
          <div className="low-stock-modal" onClick={() => resolveConfirm(false)}>
            <div className={`low-stock-modal-card confirm-modal-card confirm-modal-card-${confirmModal.tone || "danger"}`} onClick={(e) => e.stopPropagation()}>
              <div className="low-stock-modal-head">
                <h3>{confirmModal.title}</h3>
                <button type="button" onClick={() => resolveConfirm(false)}>Close</button>
              </div>
              <p className="confirm-modal-text">{confirmModal.message}</p>
              <div className="confirm-modal-actions">
                <button type="button" className="ghost" onClick={() => resolveConfirm(false)}>{confirmModal.cancelLabel || "Cancel"}</button>
                <button type="button" className={confirmModal.tone === "danger" ? "row-danger" : ""} onClick={() => resolveConfirm(true)}>{confirmModal.confirmLabel || "Confirm"}</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  };


