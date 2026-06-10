import "dotenv/config";
import express from "express";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import cors from "cors";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import { SOCKET_EVENTS } from "@pepsi/shared";
import { enrichSale, seedState } from "./seed.js";
import { getState, getStoreMeta, replaceState, updateState } from "./store.js";
import {
  createAuthUser,
  deleteAuthUser,
  extractSocketToken,
  getAuthStoreMeta,
  listUsers,
  loginUser,
  requireAuth,
  requireRole,
  revokeRefreshToken,
  rotateRefreshToken,
  updateAuthUser,
  verifyAccessToken
} from "./auth.js";

const BASE_LORRIES = ["Lorry A", "Lorry B"];
const ORDER_LORRIES = ["Lorry A", "Lorry A Overflow", "Lorry B", "Lorry B Overflow"];
const LORRY_CAPACITY = 2880;
const BUSINESS_TIME_ZONE = "Asia/Colombo";
const APP_MODE = String(process.env.APP_MODE || "live").trim().toLowerCase();
const IS_DEMO_MODE = APP_MODE === "demo";
const DEMO_READ_ONLY = String(process.env.DEMO_READ_ONLY || "false").trim().toLowerCase() === "true";
const DEMO_SNAPSHOT_FILE = String(process.env.DEMO_SNAPSHOT_FILE || "").trim();
const colomboDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const toColomboDateKey = (value = new Date()) => {
  try {
    return colomboDateFormatter.format(new Date(value));
  } catch {
    return "";
  }
};

const buildLorryLoadMap = (state) => {
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
    const saleQty = (sale.lines || []).reduce((acc, line) => acc + Number(line.quantity || 0), 0);
    next[lorryName] += saleQty;
  }
  return next;
};

const managerHasFullAccess = (state = null) => Boolean((state || getState())?.settings?.managerFullAccess);

const requireAdminOrManagerFullAccess = (req, res, next) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (role === "admin") {
    next();
    return;
  }
  if (role === "manager" && managerHasFullAccess()) {
    next();
    return;
  }
  res.status(403).json({ message: "Manager full access is required" });
};

const normalizeSalePayments = (sale) => {
  const explicit = Array.isArray(sale?.payments) ? sale.payments : [];
  if (explicit.length) return explicit;
  const migrated = [];
  if (Number(sale?.cashReceived || 0) > 0) {
    migrated.push({
      id: `legacy-cash-${sale.id || "sale"}`,
      method: "cash",
      amount: Number(Number(sale.cashReceived || 0).toFixed(2)),
      createdAt: sale.deliveryConfirmedAt || sale.createdAt || new Date().toISOString(),
      receivedBy: sale.deliveryConfirmedBy || sale.cashier || "system"
    });
  }
  if (Number(sale?.chequeAmount || 0) > 0) {
    migrated.push({
      id: `legacy-cheque-${sale.id || "sale"}`,
      method: "cheque",
      amount: Number(Number(sale.chequeAmount || 0).toFixed(2)),
      chequeNo: sale.chequeNo || "",
      chequeDate: sale.chequeDate || "",
      chequeBank: sale.chequeBank || "",
      createdAt: sale.deliveryConfirmedAt || sale.createdAt || new Date().toISOString(),
      receivedBy: sale.deliveryConfirmedBy || sale.cashier || "system"
    });
  }
  return migrated;
};

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

const totalPaymentsAmount = (payments = []) => roundMoney(
  payments.reduce((acc, payment) => acc + Number(payment.amount || 0), 0)
);

const buildCustomerCreditUsagePlan = ({ credits = [], customerName = "", amount = 0 }) => {
  const normalizedName = String(customerName || "").trim().toLowerCase();
  let remaining = roundMoney(amount);
  const usagePlan = [];
  if (!normalizedName || remaining <= 0) {
    return { usagePlan, remaining };
  }

  const eligibleCredits = [...credits]
    .filter((entry) => String(entry.customerName || "").trim().toLowerCase() === normalizedName)
    .filter((entry) => Number(entry.remainingAmount ?? entry.amount ?? 0) > 0)
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());

  for (const entry of eligibleCredits) {
    if (remaining <= 0) break;
    const available = roundMoney(entry.remainingAmount ?? entry.amount ?? 0);
    if (available <= 0) continue;
    const used = roundMoney(Math.min(available, remaining));
    if (used <= 0) continue;
    usagePlan.push({
      creditId: entry.id,
      amount: used
    });
    remaining = roundMoney(remaining - used);
  }

  return { usagePlan, remaining };
};

const restoreCustomerCreditUsage = ({ credits = [], creditPayment = null, saleId = "" }) => {
  if (!creditPayment?.usagePlan?.length) return;
  for (const usage of creditPayment.usagePlan) {
    const creditEntry = credits.find((entry) => String(entry.id) === String(usage.creditId));
    if (!creditEntry) continue;
    const currentRemaining = roundMoney(creditEntry.remainingAmount ?? creditEntry.amount ?? 0);
    creditEntry.remainingAmount = roundMoney(currentRemaining + Number(usage.amount || 0));
    creditEntry.status = "open";
    creditEntry.usageHistory = (creditEntry.usageHistory || []).filter((entry) => !(String(entry.saleId || "") === String(saleId) && Number(entry.amount || 0) === roundMoney(usage.amount || 0)));
  }
};

const applyCustomerCreditUsage = ({ credits = [], creditPayment = null, customerName = "", amount = 0, saleId = "", username = "system" }) => {
  const desiredAmount = roundMoney(amount);
  if (!creditPayment || desiredAmount <= 0) return null;
  const { usagePlan, remaining } = buildCustomerCreditUsagePlan({ credits, customerName, amount: desiredAmount });
  if (remaining > 0) {
    throw new Error("Customer credit exceeds available balance");
  }
  for (const usage of usagePlan) {
    const creditEntry = credits.find((entry) => String(entry.id) === String(usage.creditId));
    if (!creditEntry) continue;
    const currentRemaining = roundMoney(creditEntry.remainingAmount ?? creditEntry.amount ?? 0);
    creditEntry.remainingAmount = roundMoney(Math.max(0, currentRemaining - Number(usage.amount || 0)));
    creditEntry.status = creditEntry.remainingAmount > 0 ? "partial" : "used";
    creditEntry.usedAt = new Date().toISOString();
    creditEntry.usageHistory = creditEntry.usageHistory || [];
    creditEntry.usageHistory.push({
      saleId,
      amount: roundMoney(usage.amount || 0),
      createdAt: new Date().toISOString(),
      by: username
    });
  }
  return {
    ...creditPayment,
    amount: desiredAmount,
    usagePlan
  };
};

const resolveCustomerDiscountLimit = ({ customers = [], customerName = "" }) => {
  const key = String(customerName || "").trim().toLowerCase();
  if (!key || key === "walk-in") return 0;
  return roundMoney(
    (customers || [])
      .filter((customer) => String(customer?.name || "").trim().toLowerCase() === key)
      .reduce((max, customer) => Math.max(max, Number(customer?.discountLimit || 0)), 0)
  );
};

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
  if (sizeMl === 200) return 24;
  if (sizeMl === 250) return 30;
  if (sizeMl === 300) return 24;
  if (sizeMl === 400) return 24;
  if (sizeMl === 1000) return 12;
  if (sizeMl === 1500) return 12;
  if (sizeMl === 2000) return 9;
  return 0;
};

const resolveCustomerBundleDiscountLimit = ({ customers = [], customerName = "" }) => {
  const key = String(customerName || "").trim().toLowerCase();
  if (!key || key === "walk-in") return 0;
  return roundMoney(
    (customers || [])
      .filter((customer) => String(customer?.name || "").trim().toLowerCase() === key)
      .reduce((max, customer) => Math.max(max, Number(customer?.bundleDiscountLimit || 0)), 0)
  );
};

const findBundleDiscountViolation = ({ lines = [], bundleDiscountLimit = 0 }) => {
  const limit = roundMoney(bundleDiscountLimit);
  if (!(limit > 0)) return null;
  for (const line of (lines || [])) {
    const qty = Math.max(0, Number(line?.quantity || 0));
    const bundleSize = getBundleSize(line);
    if (!(bundleSize > 0) || !(qty >= bundleSize)) continue;
    const fullBundles = Math.floor(qty / bundleSize);
    if (!(fullBundles > 0)) continue;
    const unitDiscount = roundMoney(Math.max(0, Number(line?.basePrice || 0) - Number(line?.price || 0)));
    if (!(unitDiscount > 0)) continue;
    const eligibleUnits = fullBundles * bundleSize;
    const actualBundleDiscount = roundMoney(unitDiscount * eligibleUnits);
    const allowedBundleDiscount = roundMoney(fullBundles * limit);
    if (actualBundleDiscount > allowedBundleDiscount) {
      return {
        lineName: String(line?.name || "").trim() || "Item",
        fullBundles,
        bundleSize,
        actualBundleDiscount,
        allowedBundleDiscount
      };
    }
  }
  return null;
};

const calculateSaleDiscountTotal = ({ lines = [], billDiscount = 0 }) => {
  const lineDiscountTotal = roundMoney((lines || []).reduce((acc, line) => {
    const base = Number(line?.basePrice || 0);
    const price = Number(line?.price || 0);
    const qty = Number(line?.quantity || 0);
    return acc + (Math.max(0, base - price) * Math.max(0, qty));
  }, 0));
  return roundMoney(lineDiscountTotal + Math.max(0, Number(billDiscount || 0)));
};

const recalculateSaleFinancials = (sale) => {
  const payments = normalizeSalePayments(sale);
  const cashPayments = payments.filter((payment) => String(payment.method || "").toLowerCase() === "cash");
  const chequePayments = payments.filter((payment) => String(payment.method || "").toLowerCase() === "cheque");
  const allPaidPayments = payments.filter((payment) => Number(payment.amount || 0) > 0);
  const totalCash = totalPaymentsAmount(cashPayments);
  const totalCheque = totalPaymentsAmount(chequePayments);
  const latestCheque = chequePayments.length ? chequePayments[chequePayments.length - 1] : null;
  const returnedAmount = roundMoney(sale.returnedAmount || 0);
  const undeliveredAmount = computeDeliveryAdjustmentsAmount(sale);
  const netTotalAfterReturns = roundMoney(Math.max(0, Number(sale.total || 0) - returnedAmount - undeliveredAmount));
  const rawPaid = totalPaymentsAmount(allPaidPayments);
  const paidAmount = roundMoney(Math.min(netTotalAfterReturns, rawPaid));
  const outstandingAmount = roundMoney(Math.max(0, netTotalAfterReturns - paidAmount));
  const refundDueAmount = roundMoney(Math.max(0, rawPaid - netTotalAfterReturns));

  return {
    ...sale,
    payments,
    cashReceived: totalCash > 0 ? totalCash : null,
    chequeAmount: totalCheque > 0 ? totalCheque : null,
    chequeNo: latestCheque?.chequeNo || "",
    chequeDate: latestCheque?.chequeDate || "",
    chequeBank: latestCheque?.chequeBank || "",
    returnedAmount,
    undeliveredAmount,
    netTotalAfterReturns,
    paidAmount,
    outstandingAmount,
    dueAmount: outstandingAmount,
    refundDueAmount
  };
};

const pushStockMovement = (draft, entry) => {
  draft.stockMovements = draft.stockMovements || [];
  draft.stockMovements.unshift({
    id: nanoid(12),
    at: new Date().toISOString(),
    ...entry
  });
  if (draft.stockMovements.length > 5000) {
    draft.stockMovements = draft.stockMovements.slice(0, 5000);
  }
};

const buildReturnLineFinancials = ({ sale, soldLine, quantity }) => {
  const qty = Number(quantity || 0);
  const soldQty = Number(soldLine?.quantity || 0);
  const soldUnitPrice = roundMoney(soldLine?.price || 0);
  const baseUnitPrice = roundMoney(soldLine?.basePrice ?? soldUnitPrice);
  const grossAmount = roundMoney(soldUnitPrice * qty);
  const saleSubTotal = Number(sale?.subTotal || 0);
  const proportionalBillDiscount = saleSubTotal > 0
    ? roundMoney(Number(sale?.discountAmount || sale?.discount || 0) * (grossAmount / saleSubTotal))
    : 0;
  const returnAmount = roundMoney(Math.max(0, grossAmount - proportionalBillDiscount));
  const unitItemDiscount = roundMoney(Math.max(0, baseUnitPrice - soldUnitPrice));

  return {
    quantity: qty,
    baseUnitPrice,
    soldUnitPrice,
    unitItemDiscount,
    itemDiscountMode: soldLine?.itemDiscountMode || "amount",
    itemDiscountValue: roundMoney(soldLine?.itemDiscount || 0),
    grossAmount,
    billDiscountShare: proportionalBillDiscount,
    returnAmount,
    returnUnitPrice: qty > 0 ? roundMoney(returnAmount / qty) : 0,
    returnRatio: soldQty > 0 ? roundMoney(qty / soldQty) : 0
  };
};

const computeDeliveryAdjustmentsAmount = (sale, extraAdjustments = []) => {
  const saleLines = Array.isArray(sale?.lines) ? sale.lines : [];
  const qtyByProduct = new Map();
  const allAdjustments = [...(Array.isArray(sale?.deliveryAdjustments) ? sale.deliveryAdjustments : []), ...extraAdjustments];

  for (const adj of allAdjustments) {
    for (const line of (adj?.lines || [])) {
      const key = String(line.productId || "").trim();
      if (!key) continue;
      qtyByProduct.set(key, Number(qtyByProduct.get(key) || 0) + Number(line.quantity || 0));
    }
  }

  let total = 0;
  for (const soldLine of saleLines) {
    const key = String(soldLine.productId || "").trim();
    if (!key) continue;
    const soldQty = Number(soldLine.quantity || 0);
    const undeliveredQty = Math.min(soldQty, Number(qtyByProduct.get(key) || 0));
    if (undeliveredQty <= 0) continue;
    total += Number(buildReturnLineFinancials({ sale, soldLine, quantity: undeliveredQty }).returnAmount || 0);
  }

  return roundMoney(total);
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN?.split(",") || "*"
  }
});

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || "*" }));
app.use(express.json());

app.use((req, res, next) => {
  if (!IS_DEMO_MODE || !DEMO_READ_ONLY) {
    next();
    return;
  }
  const method = String(req.method || "").toUpperCase();
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    next();
    return;
  }
  const routePath = String(req.path || "");
  const isAuthRoute = routePath === "/auth/login" || routePath === "/auth/refresh" || routePath === "/auth/logout";
  const isDemoResetRoute = routePath === "/demo/reset";
  if (isAuthRoute || isDemoResetRoute) {
    next();
    return;
  }
  res.status(403).json({ message: "Demo mode is read-only" });
});

const sendFullSync = () => {
  const state = getState();
  io.emit(SOCKET_EVENTS.STATE_SYNC, {
    ...state,
    sales: (state.sales || []).map((sale) => recalculateSaleFinancials(sale))
  });
};

app.get("/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.get("/app/config", requireAuth, (_req, res) => {
  res.json({
    appMode: APP_MODE,
    businessTimeZone: BUSINESS_TIME_ZONE,
    demo: {
      enabled: IS_DEMO_MODE,
      readOnly: DEMO_READ_ONLY,
      hasSnapshot: Boolean(DEMO_SNAPSHOT_FILE)
    }
  });
});

app.get("/db/readonly", (req, res) => {
  const token = String(req.query.token || req.headers["x-readonly-token"] || "").trim();
  const expected = String(process.env.READONLY_DASHBOARD_TOKEN || "").trim();
  if (!expected) {
    res.status(503).json({ message: "READONLY_DASHBOARD_TOKEN is not configured" });
    return;
  }
  if (!token || token !== expected) {
    res.status(401).json({ message: "Invalid readonly token" });
    return;
  }

  const state = getState();
  const normalizedSales = (state.sales || []).map((sale) => recalculateSaleFinancials(sale));
  const today = toColomboDateKey();
  const todaySales = normalizedSales.filter((sale) => toColomboDateKey(sale.createdAt) === today);
  const todayRevenue = todaySales.reduce((acc, sale) => acc + Number(sale.netTotalAfterReturns || 0), 0);

  res.json({
    now: new Date().toISOString(),
    storage: {
      state: getStoreMeta(),
      auth: getAuthStoreMeta()
    },
    counts: {
      products: (state.products || []).length,
      customers: (state.customers || []).length,
      staff: (state.staff || []).length,
      sales: normalizedSales.length,
      returns: (state.returns || []).length,
      todaySales: todaySales.length,
      todayRevenue: Number(todayRevenue.toFixed(2))
    },
    latestSales: normalizedSales.slice(0, 20).map((sale) => ({
      id: sale.id,
      createdAt: sale.createdAt,
      rep: sale.cashier || "-",
      customer: sale.customerName || "-",
      lorry: sale.lorry || "-",
      total: Number(sale.netTotalAfterReturns || 0)
    }))
  });
});

app.post("/auth/login", (req, res) => {
  const { role, username, password } = req.body || {};
  loginUser({ role, username, password })
    .then((session) => {
      if (!session) {
        res.status(401).json({ message: "Invalid credentials" });
        return;
      }
      res.json(session);
    })
    .catch(() => {
      res.status(500).json({ message: "Unable to login" });
    });
});

app.post("/auth/refresh", (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    res.status(400).json({ message: "refreshToken is required" });
    return;
  }

  const nextSession = rotateRefreshToken(refreshToken);
  if (!nextSession) {
    res.status(401).json({ message: "Invalid or expired refresh token" });
    return;
  }

  res.json(nextSession);
});

app.post("/auth/logout", (req, res) => {
  const { refreshToken } = req.body || {};
  revokeRefreshToken(refreshToken);
  res.json({ ok: true });
});

app.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get("/auth/users", requireAuth, requireAdminOrManagerFullAccess, (_req, res) => {
  res.json(listUsers());
});

app.post("/auth/users", requireAuth, requireAdminOrManagerFullAccess, async (req, res) => {
  try {
    const user = await createAuthUser(req.body || {});
    res.status(201).json(user);
  } catch (error) {
    res.status(400).json({ message: error.message || "Unable to create user" });
  }
});

app.patch("/auth/users/:id", requireAuth, requireAdminOrManagerFullAccess, async (req, res) => {
  try {
    const user = await updateAuthUser(req.params.id, req.body || {});
    res.json(user);
  } catch (error) {
    const message = error.message || "Unable to update user";
    const status = /not found/i.test(message) ? 404 : 400;
    res.status(status).json({ message });
  }
});

app.delete("/auth/users/:id", requireAuth, requireAdminOrManagerFullAccess, async (req, res) => {
  try {
    const user = await deleteAuthUser(req.params.id, req.user?.id || "");
    res.json(user);
  } catch (error) {
    const message = error.message || "Unable to delete user";
    const status = /not found/i.test(message) ? 404 : 400;
    res.status(status).json({ message });
  }
});

app.get("/state", requireAuth, (_req, res) => {
  const state = getState();
  res.json({
    ...state,
    sales: (state.sales || []).map((sale) => recalculateSaleFinancials(sale))
  });
});

app.get("/products", requireAuth, (_req, res) => {
  res.json(getState().products);
});

app.post("/products", requireAuth, requireAdminOrManagerFullAccess, (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const size = String(body.size || "").trim();
  const sku = String(body.sku || "").trim();
  const category = String(body.category || "General").trim();
  const billingPrice = Number(body.billingPrice);
  const invoicePrice = body.invoicePrice !== undefined ? Number(body.invoicePrice) : 0;
  const mrp = Number(body.mrp);
  const stock = Number(body.stock);

  if (!name || !sku || Number.isNaN(billingPrice) || Number.isNaN(mrp) || Number.isNaN(stock) || Number.isNaN(invoicePrice)) {
    res.status(400).json({ message: "name, sku, invoicePrice, billingPrice, mrp, stock are required" });
    return;
  }

  const state = getState();
  const exists = state.products.find((item) => item.sku.toLowerCase() === sku.toLowerCase());
  if (exists) {
    res.status(409).json({ message: `Product SKU already exists: ${sku}` });
    return;
  }

  const created = {
    id: `p-${nanoid(8)}`,
    name,
    size,
    sku,
    category: category || "General",
      price: mrp,
      invoicePrice,
      billingPrice,
      mrp,
      stock
  };

  updateState((draft) => {
    draft.products.unshift(created);
    pushStockMovement(draft, {
      action: "create_product",
      by: req.user?.username || "system",
      productId: created.id,
      sku: created.sku || "",
      name: created.name || "",
      beforeStock: 0,
      changeQty: Number(created.stock || 0),
      afterStock: Number(created.stock || 0)
    });
    return draft;
  });

  io.emit(SOCKET_EVENTS.PRODUCT_UPDATED, created);
  sendFullSync();
  res.status(201).json(created);
});

app.patch("/products/:id", requireAuth, requireAdminOrManagerFullAccess, (req, res) => {
  const { id } = req.params;
  const patch = req.body || {};
  const incomingSku = patch.sku ? String(patch.sku).trim() : null;

  if (incomingSku) {
    const state = getState();
    const conflict = state.products.find((item) => item.id !== id && item.sku.toLowerCase() === incomingSku.toLowerCase());
    if (conflict) {
      res.status(409).json({ message: `SKU already exists: ${incomingSku}` });
      return;
    }
  }

  const next = updateState((state) => {
    const index = state.products.findIndex((item) => item.id === id);
    if (index === -1) {
      return state;
    }
    const previous = state.products[index];
    const previousStock = Number(previous.stock || 0);

    const updated = {
      ...previous,
      ...patch,
      size: patch.size !== undefined ? String(patch.size || "").trim() : previous.size,
      sku: incomingSku ?? previous.sku,
      invoicePrice: patch.invoicePrice !== undefined ? Number(patch.invoicePrice) : (previous.invoicePrice ?? 0),
      billingPrice: patch.billingPrice !== undefined ? Number(patch.billingPrice) : previous.billingPrice,
      mrp: patch.mrp !== undefined ? Number(patch.mrp) : previous.mrp,
      price: patch.price !== undefined ? Number(patch.price) : previous.price,
      stock: patch.stock !== undefined ? Number(patch.stock) : previous.stock
    };
    state.products[index] = updated;
    const nextStock = Number(updated.stock || 0);
    if (Number.isFinite(previousStock) && Number.isFinite(nextStock) && previousStock !== nextStock) {
      pushStockMovement(state, {
        action: "update_stock",
        by: req.user?.username || "system",
        productId: updated.id,
        sku: updated.sku || "",
        name: updated.name || "",
        beforeStock: previousStock,
        changeQty: Number((nextStock - previousStock).toFixed(2)),
        afterStock: nextStock
      });
    }

    return state;
  });

  const updated = next.products.find((item) => item.id === id);
  if (!updated) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  io.emit(SOCKET_EVENTS.PRODUCT_UPDATED, updated);
  sendFullSync();
  res.json(updated);
});

app.delete("/products/:id", requireAuth, requireAdminOrManagerFullAccess, (req, res) => {
  const { id } = req.params;
  let removed = null;

  const next = updateState((state) => {
    const index = state.products.findIndex((item) => item.id === id);
    if (index === -1) return state;
    removed = state.products[index];
    pushStockMovement(state, {
      action: "delete_product",
      by: req.user?.username || "system",
      productId: removed.id,
      sku: removed.sku || "",
      name: removed.name || "",
      beforeStock: Number(removed.stock || 0),
      changeQty: Number((0 - Number(removed.stock || 0)).toFixed(2)),
      afterStock: 0
    });
    state.products.splice(index, 1);
    return state;
  });

  if (!removed) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  io.emit(SOCKET_EVENTS.PRODUCT_UPDATED, { id, deleted: true });
  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.json({ ok: true, deleted: removed });
});

app.get("/sales", requireAuth, (_req, res) => {
  res.json(getState().sales);
});

app.get("/customers", requireAuth, requireRole("admin"), (_req, res) => {
  res.json(getState().customers || []);
});

app.post("/customers", requireAuth, requireRole("admin", "cashier", "manager"), (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const address = String(body.address || "").trim();
  const rawOpeningOutstanding = Number(body.openingOutstanding || 0);
  const rawCreditLimit = Number(body.creditLimit || 0);
  const rawDiscountLimit = Number(body.discountLimit || 0);
  const rawBundleDiscountLimit = Number(body.bundleDiscountLimit || 0);
  const rawOutstandingAdjustment = Number(body.outstandingAdjustment || 0);
  const outstandingAdjustmentReason = String(body.outstandingAdjustmentReason || "").trim().slice(0, 240);
  const openingOutstanding = Number.isFinite(rawOpeningOutstanding) && rawOpeningOutstanding > 0
    ? roundMoney(rawOpeningOutstanding)
    : 0;
  const creditLimit = Number.isFinite(rawCreditLimit) && rawCreditLimit > 0
    ? roundMoney(rawCreditLimit)
    : 0;
  const discountLimit = Number.isFinite(rawDiscountLimit) && rawDiscountLimit > 0
    ? roundMoney(rawDiscountLimit)
    : 0;
  const bundleDiscountLimit = Number.isFinite(rawBundleDiscountLimit) && rawBundleDiscountLimit > 0
    ? roundMoney(rawBundleDiscountLimit)
    : 0;
  const outstandingAdjustment = Number.isFinite(rawOutstandingAdjustment) && rawOutstandingAdjustment > 0
    ? roundMoney(rawOutstandingAdjustment)
    : 0;
  if (!name) {
    res.status(400).json({ message: "Customer name is required" });
    return;
  }
  if (req.user?.role === "cashier" && (!phone || !address)) {
    res.status(400).json({ message: "Customer mobile and address are required for rep login" });
    return;
  }

  const role = String(req.user?.role || "").toLowerCase();
  const canManageOpeningOutstanding = role === "admin" || (role === "manager" && managerHasFullAccess());
  const canManageCustomerLimits = role === "admin" || (role === "manager" && managerHasFullAccess());
  const canManageOutstandingAdjustment = role === "admin";
  const record = {
    id: nanoid(12),
    name,
    phone,
    address,
    openingOutstanding: canManageOpeningOutstanding ? openingOutstanding : 0,
    creditLimit: canManageCustomerLimits ? creditLimit : 0,
    discountLimit: canManageCustomerLimits ? discountLimit : 0,
    bundleDiscountLimit: canManageCustomerLimits ? bundleDiscountLimit : 0,
    outstandingAdjustment: canManageOutstandingAdjustment ? outstandingAdjustment : 0,
    outstandingAdjustmentReason: canManageOutstandingAdjustment ? outstandingAdjustmentReason : "",
    createdAt: new Date().toISOString()
  };

  updateState((state) => {
    state.customers = state.customers || [];
    state.customers.push(record);
    return state;
  });

  sendFullSync();
  res.status(201).json(record);
});

app.patch("/customers/:id", requireAuth, requireRole("admin", "cashier", "manager"), (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  if (req.user?.role === "manager" && !managerHasFullAccess()) {
    res.status(403).json({ message: "Manager full access is required to edit customers" });
    return;
  }
  const hasOpeningOutstanding = Object.prototype.hasOwnProperty.call(body, "openingOutstanding");
  const hasCreditLimit = Object.prototype.hasOwnProperty.call(body, "creditLimit");
  const hasDiscountLimit = Object.prototype.hasOwnProperty.call(body, "discountLimit");
  const hasBundleDiscountLimit = Object.prototype.hasOwnProperty.call(body, "bundleDiscountLimit");
  const hasOutstandingAdjustment = Object.prototype.hasOwnProperty.call(body, "outstandingAdjustment");
  const hasOutstandingAdjustmentReason = Object.prototype.hasOwnProperty.call(body, "outstandingAdjustmentReason");
  const rawOpeningOutstanding = Number(body.openingOutstanding || 0);
  const rawCreditLimit = Number(body.creditLimit || 0);
  const rawDiscountLimit = Number(body.discountLimit || 0);
  const rawBundleDiscountLimit = Number(body.bundleDiscountLimit || 0);
  const rawOutstandingAdjustment = Number(body.outstandingAdjustment || 0);
  const outstandingAdjustmentReason = String(body.outstandingAdjustmentReason || "").trim().slice(0, 240);
  const openingOutstanding = Number.isFinite(rawOpeningOutstanding) && rawOpeningOutstanding > 0
    ? roundMoney(rawOpeningOutstanding)
    : 0;
  const creditLimit = Number.isFinite(rawCreditLimit) && rawCreditLimit > 0
    ? roundMoney(rawCreditLimit)
    : 0;
  const discountLimit = Number.isFinite(rawDiscountLimit) && rawDiscountLimit > 0
    ? roundMoney(rawDiscountLimit)
    : 0;
  const bundleDiscountLimit = Number.isFinite(rawBundleDiscountLimit) && rawBundleDiscountLimit > 0
    ? roundMoney(rawBundleDiscountLimit)
    : 0;
  const outstandingAdjustment = Number.isFinite(rawOutstandingAdjustment) && rawOutstandingAdjustment > 0
    ? roundMoney(rawOutstandingAdjustment)
    : 0;
  if ((hasOutstandingAdjustment || hasOutstandingAdjustmentReason) && String(req.user?.role || "").toLowerCase() !== "admin") {
    res.status(403).json({ message: "Only admin can adjust total outstanding" });
    return;
  }

  const next = updateState((state) => {
    state.customers = state.customers || [];
    const idx = state.customers.findIndex((item) => item.id === id);
    if (idx === -1) return state;
    if (req.user?.role === "cashier") {
      state.customers[idx] = {
        ...state.customers[idx],
        phone: String(body.phone || "").trim()
      };
    } else if (req.user?.role === "manager") {
      state.customers[idx] = {
        ...state.customers[idx],
        name: body.name !== undefined ? String(body.name || "").trim() : state.customers[idx].name,
        phone: body.phone !== undefined ? String(body.phone || "").trim() : state.customers[idx].phone,
        address: body.address !== undefined ? String(body.address || "").trim() : state.customers[idx].address,
        ...(hasOpeningOutstanding ? { openingOutstanding } : {}),
        ...(hasCreditLimit ? { creditLimit } : {}),
        ...(hasDiscountLimit ? { discountLimit } : {}),
        ...(hasBundleDiscountLimit ? { bundleDiscountLimit } : {})
      };
    } else {
      state.customers[idx] = {
        ...state.customers[idx],
        ...body,
        ...(hasOpeningOutstanding ? { openingOutstanding } : {}),
        ...(hasCreditLimit ? { creditLimit } : {}),
        ...(hasDiscountLimit ? { discountLimit } : {}),
        ...(hasBundleDiscountLimit ? { bundleDiscountLimit } : {}),
        ...(hasOutstandingAdjustment ? { outstandingAdjustment } : {}),
        ...(hasOutstandingAdjustmentReason ? { outstandingAdjustmentReason } : {})
      };
    }
    return state;
  });

  const updated = (next.customers || []).find((item) => item.id === id);
  if (!updated) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }

  sendFullSync();
  res.json(updated);
});

app.post("/settings/lorry-count-reset", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const now = new Date().toISOString();
  const next = updateState((state) => {
    state.settings = state.settings || {};
    state.settings.lorryCountResetAt = {
      "Lorry A": now,
      "Lorry B": now
    };
    return state;
  });

  sendFullSync();
  res.json(next.settings?.lorryCountResetAt || {});
});

app.post("/settings/loading-row-mark", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const markKey = String(req.body?.markKey || "").trim();
  const loaded = Boolean(req.body?.loaded);
  if (!markKey) {
    res.status(400).json({ message: "Loading mark key is required" });
    return;
  }
  const next = updateState((state) => {
    state.settings = state.settings || {};
    state.settings.loadingRowMarks = state.settings.loadingRowMarks || {};
    if (loaded) {
      state.settings.loadingRowMarks[markKey] = {
        loaded: true,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user?.username || "admin"
      };
    } else {
      delete state.settings.loadingRowMarks[markKey];
    }
    return state;
  });

  sendFullSync();
  res.json(next.settings?.loadingRowMarks || {});
});

app.post("/settings/manager-full-access", requireAuth, requireRole("admin"), (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const next = updateState((state) => {
    state.settings = state.settings || {};
    state.settings.managerFullAccess = enabled;
    return state;
  });
  sendFullSync();
  res.json({ enabled: Boolean(next.settings?.managerFullAccess) });
});

app.get("/staff", requireAuth, requireRole("admin", "manager"), (_req, res) => {
  res.json(getState().staff || []);
});

app.post("/staff", requireAuth, requireAdminOrManagerFullAccess, (req, res) => {
  const body = req.body || {};
  if (!body.name?.trim()) {
    res.status(400).json({ message: "Staff name is required" });
    return;
  }

  const record = {
    id: nanoid(12),
    name: body.name.trim(),
    role: body.role || "",
    phone: body.phone || "",
    createdAt: new Date().toISOString()
  };

  updateState((state) => {
    state.staff = state.staff || [];
    state.staff.push(record);
    return state;
  });

  sendFullSync();
  res.status(201).json(record);
});

app.patch("/staff/:id", requireAuth, requireAdminOrManagerFullAccess, (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  const next = updateState((state) => {
    state.staff = state.staff || [];
    const idx = state.staff.findIndex((item) => item.id === id);
    if (idx === -1) return state;
    state.staff[idx] = { ...state.staff[idx], ...body };
    return state;
  });

  const updated = (next.staff || []).find((item) => item.id === id);
  if (!updated) {
    res.status(404).json({ message: "Staff not found" });
    return;
  }

  sendFullSync();
  res.json(updated);
});

app.delete("/staff/:id", requireAuth, requireAdminOrManagerFullAccess, (req, res) => {
  const { id } = req.params;
  const next = updateState((state) => {
    state.staff = state.staff || [];
    state.staff = state.staff.filter((item) => String(item.id || "") !== String(id || ""));
    return state;
  });

  const exists = (next.staff || []).some((item) => String(item.id || "") === String(id || ""));
  if (exists) {
    res.status(400).json({ message: "Unable to delete staff" });
    return;
  }

  sendFullSync();
  res.json({ ok: true });
});

app.post("/sales", requireAuth, requireRole("cashier", "admin"), (req, res) => {
  const body = req.body || {};
  const requestId = String(body.requestId || "").trim();
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const lorry = String(body.lorry || "").trim();
  const customerPhone = String(body.customerPhone || "").trim();
  const paymentType = String(body.paymentType || "cash");
  const customerCreditAmount = roundMoney(Number(body.customerCreditAmount || 0));
  const cashReceived = Number(body.cashReceived || 0);
  const creditDueDate = String(body.creditDueDate || "").trim();
  const chequeAmount = Number(body.chequeAmount || 0);
  const chequeNo = String(body.chequeNo || "").trim();
  const chequeDate = String(body.chequeDate || "").trim();
  const chequeBank = String(body.chequeBank || "").trim();

  if (!lines.length) {
    res.status(400).json({ message: "Cart is empty" });
    return;
  }
  if (!Number.isFinite(customerCreditAmount) || customerCreditAmount < 0) {
    res.status(400).json({ message: "customerCreditAmount must be 0 or more" });
    return;
  }
  if (!ORDER_LORRIES.includes(lorry)) {
    res.status(400).json({ message: "Lorry selection is required" });
    return;
  }

  const state = getState();
  if (requestId) {
    const existingSale = (state.sales || []).find((item) => String(item.requestId || "") === requestId);
    if (existingSale) {
      res.status(200).json(existingSale);
      return;
    }
  }
  const productMap = new Map(state.products.map((p) => [p.id, p]));
  const maxSaleNo = (state.sales || []).reduce((max, sale) => {
    const raw = String(sale.id || "").trim();
    const asNumber = /^\d+$/.test(raw) ? Number(raw) : 0;
    return Math.max(max, asNumber);
  }, 0);
  const nextSaleId = String(maxSaleNo + 1).padStart(5, "0");
  const preparedLines = [];

  for (const line of lines) {
    const product = productMap.get(line.productId);
    if (!product) {
      res.status(404).json({ message: `Unknown product ${line.productId}` });
      return;
    }
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ message: `Invalid quantity for ${product.name}` });
      return;
    }
    if (product.stock < quantity) {
      res.status(409).json({ message: `Insufficient stock for ${product.name}` });
      return;
    }
    const basePrice = Number(
      line.basePrice ?? product.billingPrice ?? product.price ?? product.mrp ?? 0
    );
    const incomingMode = String(line.itemDiscountMode || "amount").trim().toLowerCase();
    const itemDiscountMode = incomingMode === "percent" ? "percent" : "amount";
    const rawDiscount = Number(line.itemDiscount || 0);
    const safeDiscount = Number.isFinite(rawDiscount) && rawDiscount > 0 ? rawDiscount : 0;
    const discountAmount = itemDiscountMode === "percent"
      ? Math.min(100, safeDiscount)
      : Math.min(basePrice, safeDiscount);
    const netUnitPrice = Number(line.price);
    const resolvedUnitPrice = Number.isFinite(netUnitPrice)
      ? Math.max(0, netUnitPrice)
      : Math.max(0, itemDiscountMode === "percent"
        ? Number((basePrice - ((basePrice * discountAmount) / 100)).toFixed(2))
        : Number((basePrice - discountAmount).toFixed(2)));
    preparedLines.push({
      productId: product.id,
      name: line.name || `${product.name}${product.size ? ` ${product.size}` : ""}`,
      size: product.size || "",
      category: product.category || "",
      quantity,
      basePrice: Number(basePrice.toFixed(2)),
      itemDiscount: Number(discountAmount.toFixed(2)),
      itemDiscountMode,
      price: Number(resolvedUnitPrice.toFixed(2))
    });
  }

  const currentOrderQty = preparedLines.reduce((acc, line) => acc + Number(line.quantity || 0), 0);
  const lorryLoadMap = buildLorryLoadMap(state);
  const pendingLoad = Number(lorryLoadMap[lorry] || 0);
  if (BASE_LORRIES.includes(lorry)) {
    if (pendingLoad >= LORRY_CAPACITY) {
      res.status(409).json({ message: "Selected lorry is full." });
      return;
    }
    if ((pendingLoad + currentOrderQty) > LORRY_CAPACITY) {
      res.status(409).json({
        message: `Selected lorry exceeds capacity. Only ${Math.max(0, LORRY_CAPACITY - pendingLoad)} items left.`
      });
      return;
    }
  }

  const prepared = enrichSale({
    id: nextSaleId,
    requestId,
    createdAt: new Date().toISOString(),
    cashier: body.cashier || req.user.username,
    customerName: body.customerName || "Walk-in",
    customerPhone,
    lorry,
    paymentType,
    notes: body.notes || "",
    discount: Number(body.discount || 0),
    taxRate: 0,
    payments: [],
    lines: preparedLines
  });

  const preparedCustomerName = String(prepared.customerName || "").trim();
  const customerDiscountLimit = resolveCustomerDiscountLimit({ customers: state.customers || [], customerName: preparedCustomerName });
  const customerBundleDiscountLimit = resolveCustomerBundleDiscountLimit({ customers: state.customers || [], customerName: preparedCustomerName });
  const totalDiscountApplied = calculateSaleDiscountTotal({ lines: prepared.lines, billDiscount: prepared.discountAmount ?? prepared.discount ?? 0 });
  if (String(req.user?.role || "").toLowerCase() === "cashier" && customerDiscountLimit > 0 && totalDiscountApplied > customerDiscountLimit) {
    res.status(409).json({ message: `Discount limit exceeded for ${preparedCustomerName}. Allowed: ${customerDiscountLimit.toFixed(2)}` });
    return;
  }
  const bundleDiscountViolation = findBundleDiscountViolation({ lines: prepared.lines, bundleDiscountLimit: customerBundleDiscountLimit });
  if (String(req.user?.role || "").toLowerCase() === "cashier" && bundleDiscountViolation) {
    res.status(409).json({ message: `${bundleDiscountViolation.lineName} exceeds bundle discount limit. Allowed: ${bundleDiscountViolation.allowedBundleDiscount.toFixed(2)} for ${bundleDiscountViolation.fullBundles} bundle(s)` });
    return;
  }
  if (customerCreditAmount > 0) {
    if (!preparedCustomerName || preparedCustomerName.toLowerCase() === "walk-in") {
      res.status(409).json({ message: "Customer credit can be used only for saved customers" });
      return;
    }
    if (customerCreditAmount > roundMoney(Number(prepared.total || 0))) {
      res.status(409).json({ message: "Customer credit cannot exceed bill total" });
      return;
    }
    const { usagePlan, remaining } = buildCustomerCreditUsagePlan({
      credits: state.customerCredits || [],
      customerName: preparedCustomerName,
      amount: customerCreditAmount
    });
    if (remaining > 0) {
      res.status(409).json({ message: "Customer credit exceeds available balance" });
      return;
    }
    prepared.payments = [{
      id: nanoid(12),
      method: "customer_credit",
      amount: customerCreditAmount,
      createdAt: new Date().toISOString(),
      receivedBy: req.user?.username || "system",
      usagePlan
    }];
    prepared.customerCreditApplied = customerCreditAmount;
  }

  prepared.cashReceived = null;
  prepared.creditDueDate = creditDueDate || "";
  prepared.chequeAmount = null;
    prepared.chequeNo = "";
    prepared.chequeDate = "";
    prepared.chequeBank = "";
    prepared.returnedAmount = 0;
    prepared.refundDueAmount = 0;
    Object.assign(prepared, recalculateSaleFinancials(prepared));

  const next = updateState((draft) => {
    draft.sales.unshift(prepared);
    draft.customers = draft.customers || [];
    draft.staff = draft.staff || [];

    for (const line of prepared.lines) {
      const product = draft.products.find((item) => item.id === line.productId);
      if (product) {
        product.stock = Number((product.stock - line.quantity).toFixed(2));
      }
    }

    const existingCustomer = draft.customers.find((item) => item.name.toLowerCase() === prepared.customerName.toLowerCase());
    if (!existingCustomer && prepared.customerName && prepared.customerName !== "Walk-in") {
      draft.customers.push({
        id: nanoid(12),
        name: prepared.customerName,
        phone: prepared.customerPhone || "",
        address: "",
        createdAt: new Date().toISOString()
      });
    } else if (existingCustomer && prepared.customerPhone) {
      existingCustomer.phone = prepared.customerPhone;
    }

    const existingStaff = draft.staff.find((item) => item.name.toLowerCase() === prepared.cashier.toLowerCase());
    if (!existingStaff && prepared.cashier) {
      draft.staff.push({
        id: nanoid(12),
        name: prepared.cashier,
        role: "Cashier",
        phone: "",
        createdAt: new Date().toISOString()
      });
    }

    if (Number(prepared.customerCreditApplied || 0) > 0) {
      draft.customerCredits = draft.customerCredits || [];
      const creditPayment = (prepared.payments || []).find((payment) => String(payment.method || "").toLowerCase() === "customer_credit");
      for (const usage of (creditPayment?.usagePlan || [])) {
        const creditEntry = draft.customerCredits.find((entry) => String(entry.id) === String(usage.creditId));
        if (!creditEntry) continue;
        const currentRemaining = roundMoney(creditEntry.remainingAmount ?? creditEntry.amount ?? 0);
        creditEntry.remainingAmount = roundMoney(Math.max(0, currentRemaining - Number(usage.amount || 0)));
        creditEntry.status = creditEntry.remainingAmount > 0 ? "partial" : "used";
        creditEntry.usedAt = new Date().toISOString();
        creditEntry.usageHistory = creditEntry.usageHistory || [];
        creditEntry.usageHistory.push({
          saleId: prepared.id,
          amount: roundMoney(usage.amount || 0),
          createdAt: new Date().toISOString(),
          by: req.user?.username || "system"
        });
      }
    }

    return draft;
  });

  io.emit(SOCKET_EVENTS.SALE_CREATED, prepared);
  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.status(201).json(prepared);
});

app.patch("/sales/:id", requireAuth, requireRole("cashier", "admin", "manager"), (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) {
    res.status(400).json({ message: "At least one line is required" });
    return;
  }

  const state = getState();
  const sale = (state.sales || []).find((item) => String(item.id) === String(id));
  if (!sale) {
    res.status(404).json({ message: "Sale not found" });
    return;
  }
  const nextPaymentType = String(body.paymentType || sale?.paymentType || "").trim();
  const nextBillDiscount = Math.max(0, Number(body.discount || 0) || 0);

  const saleCashier = String(sale.cashier || "").trim().toLowerCase();
  const actingUser = String(req.user?.username || "").trim().toLowerCase();
  const isAdmin = ["admin", "manager"].includes(String(req.user?.role || "").toLowerCase());
  if (!isAdmin && (!saleCashier || saleCashier !== actingUser)) {
    res.status(403).json({ message: "Only the rep who created this sale can edit it" });
    return;
  }

  const hasReturns = (state.returns || []).some((ret) => String(ret.saleId) === String(sale.id));
  if (hasReturns) {
    res.status(409).json({ message: "Cannot edit sale after returns have been submitted" });
    return;
  }
  const hasDeliveryAdjustments = Array.isArray(sale.deliveryAdjustments) && sale.deliveryAdjustments.length > 0;
  if (sale.deliveryConfirmedAt || hasDeliveryAdjustments) {
    res.status(409).json({ message: "Cannot edit sale after delivery processing has started" });
    return;
  }

  const productMap = new Map((state.products || []).map((p) => [p.id, p]));
  const oldQtyByProduct = new Map();
  for (const line of (sale.lines || [])) {
    oldQtyByProduct.set(line.productId, (oldQtyByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
  }

  const preparedLines = [];
  const newQtyByProduct = new Map();
  for (const line of lines) {
    const productId = String(line.productId || "").trim();
    const quantity = Number(line.quantity || 0);
    const product = productMap.get(productId);
    if (!product || !Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ message: "Invalid sale edit line" });
      return;
    }
    newQtyByProduct.set(productId, (newQtyByProduct.get(productId) || 0) + quantity);
    const basePrice = Number(
      line.basePrice ?? product.billingPrice ?? product.price ?? product.mrp ?? 0
    );
    const incomingMode = String(line.itemDiscountMode || "amount").trim().toLowerCase();
    const itemDiscountMode = incomingMode === "percent" ? "percent" : "amount";
    const rawDiscount = Number(line.itemDiscount || 0);
    const safeDiscount = Number.isFinite(rawDiscount) && rawDiscount > 0 ? rawDiscount : 0;
    const discountAmount = itemDiscountMode === "percent"
      ? Math.min(100, safeDiscount)
      : Math.min(basePrice, safeDiscount);
    const netUnitPrice = Number(line.price);
    const resolvedUnitPrice = Number.isFinite(netUnitPrice)
      ? Math.max(0, netUnitPrice)
      : Math.max(0, itemDiscountMode === "percent"
        ? Number((basePrice - ((basePrice * discountAmount) / 100)).toFixed(2))
        : Number((basePrice - discountAmount).toFixed(2)));
    preparedLines.push({
      productId,
      name: line.name || `${product.name}${product.size ? ` ${product.size}` : ""}`,
      size: product.size || "",
      category: product.category || "",
      quantity,
      basePrice: Number(basePrice.toFixed(2)),
      itemDiscount: Number(discountAmount.toFixed(2)),
      itemDiscountMode,
      price: Number(resolvedUnitPrice.toFixed(2))
    });
  }

  const allProductIds = new Set([...oldQtyByProduct.keys(), ...newQtyByProduct.keys()]);
  for (const productId of allProductIds) {
    const product = productMap.get(productId);
    if (!product) continue;
    const oldQty = Number(oldQtyByProduct.get(productId) || 0);
    const nextQty = Number(newQtyByProduct.get(productId) || 0);
    const projectedStock = Number(product.stock || 0) + oldQty - nextQty;
    if (projectedStock < 0) {
      res.status(409).json({ message: `Insufficient stock for ${product.name}` });
      return;
    }
  }

  const existingPayments = normalizeSalePayments(sale);
  const existingCreditPayment = existingPayments.find((payment) => String(payment.method || "").toLowerCase() === "customer_credit") || null;
  const editSubTotal = roundMoney(preparedLines.reduce((acc, line) => acc + (Number(line.price || 0) * Number(line.quantity || 0)), 0));
  if (nextBillDiscount > editSubTotal) {
    res.status(409).json({ message: `Total bill discount cannot exceed subtotal (${editSubTotal.toFixed(2)})` });
    return;
  }
  const customerDiscountLimit = resolveCustomerDiscountLimit({ customers: state.customers || [], customerName: sale.customerName });
  const customerBundleDiscountLimit = resolveCustomerBundleDiscountLimit({ customers: state.customers || [], customerName: sale.customerName });
  const totalDiscountApplied = calculateSaleDiscountTotal({ lines: preparedLines, billDiscount: nextBillDiscount });
  if (!isAdmin && customerDiscountLimit > 0 && totalDiscountApplied > customerDiscountLimit) {
    res.status(409).json({ message: `Discount limit exceeded for ${sale.customerName}. Allowed: ${customerDiscountLimit.toFixed(2)}` });
    return;
  }
  const bundleDiscountViolation = findBundleDiscountViolation({ lines: preparedLines, bundleDiscountLimit: customerBundleDiscountLimit });
  if (!isAdmin && bundleDiscountViolation) {
    res.status(409).json({ message: `${bundleDiscountViolation.lineName} exceeds bundle discount limit. Allowed: ${bundleDiscountViolation.allowedBundleDiscount.toFixed(2)} for ${bundleDiscountViolation.fullBundles} bundle(s)` });
    return;
  }

  const simulatedCredits = (state.customerCredits || []).map((entry) => ({
    ...entry,
    usageHistory: [...(entry.usageHistory || [])]
  }));
  restoreCustomerCreditUsage({ credits: simulatedCredits, creditPayment: existingCreditPayment, saleId: sale.id });

  const nextPayments = existingPayments.filter((payment) => String(payment.method || "").toLowerCase() !== "customer_credit");
  if (existingCreditPayment) {
    const desiredCreditAmount = roundMoney(Math.min(Number(existingCreditPayment.amount || 0), Number(enrichSale({
      ...sale,
      paymentType: nextPaymentType || sale.paymentType,
      discount: nextBillDiscount,
      discountAmount: nextBillDiscount,
      payments: nextPayments,
      lines: preparedLines,
      taxRate: 0
    }).total || 0)));
    if (desiredCreditAmount > 0) {
      try {
        const rebalancedCreditPayment = applyCustomerCreditUsage({
          credits: simulatedCredits,
          creditPayment: existingCreditPayment,
          customerName: sale.customerName,
          amount: desiredCreditAmount,
          saleId: sale.id,
          username: req.user?.username || "system"
        });
        if (rebalancedCreditPayment) {
          nextPayments.push(rebalancedCreditPayment);
        }
      } catch (error) {
        res.status(409).json({ message: error.message || "Unable to rebalance customer credit for edited bill" });
        return;
      }
    }
  }

  const recalculated = recalculateSaleFinancials(enrichSale({
    ...sale,
    paymentType: nextPaymentType || sale.paymentType,
    discount: nextBillDiscount,
    discountAmount: nextBillDiscount,
    payments: nextPayments,
    lines: preparedLines,
    taxRate: 0
  }));

  const next = updateState((draft) => {
    const idx = draft.sales.findIndex((item) => String(item.id) === String(id));
    if (idx === -1) return draft;

    for (const productId of allProductIds) {
      const product = draft.products.find((p) => p.id === productId);
      if (!product) continue;
      const oldQty = Number(oldQtyByProduct.get(productId) || 0);
      const nextQty = Number(newQtyByProduct.get(productId) || 0);
      product.stock = Number((Number(product.stock || 0) + oldQty - nextQty).toFixed(2));
    }

    if (existingCreditPayment) {
      draft.customerCredits = draft.customerCredits || [];
      restoreCustomerCreditUsage({ credits: draft.customerCredits, creditPayment: existingCreditPayment, saleId: sale.id });
      const nextCreditPayment = nextPayments.find((payment) => String(payment.method || "").toLowerCase() === "customer_credit");
      if (nextCreditPayment) {
        applyCustomerCreditUsage({
          credits: draft.customerCredits,
          creditPayment: nextCreditPayment,
          customerName: sale.customerName,
          amount: Number(nextCreditPayment.amount || 0),
          saleId: sale.id,
          username: req.user?.username || "system"
        });
      }
    }

    draft.sales[idx] = recalculated;
    return draft;
  });

  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.json(recalculated);
});

app.delete("/sales/:id", requireAuth, requireRole("admin", "cashier", "manager"), (req, res) => {
  const { id } = req.params;
  const state = getState();
  const sale = (state.sales || []).find((item) => String(item.id) === String(id));
  if (!sale) {
    res.status(404).json({ message: "Sale not found" });
    return;
  }
  if (req.user?.role === "cashier") {
    const saleCashier = String(sale.cashier || "").trim().toLowerCase();
    const actingUser = String(req.user?.username || "").trim().toLowerCase();
    if (!saleCashier || saleCashier !== actingUser) {
      res.status(403).json({ message: "You can delete only your own bills" });
      return;
    }
  }
  const hasDeliveryProcessing = Boolean(sale.deliveryConfirmedAt) || (Array.isArray(sale.deliveryAdjustments) && sale.deliveryAdjustments.length > 0);
  if (hasDeliveryProcessing) {
    res.status(409).json({ message: "Cannot delete sale after delivery processing has started" });
    return;
  }

  const returnedByProduct = new Map();
  for (const ret of (state.returns || [])) {
    if (String(ret.saleId) !== String(id)) continue;
    for (const line of (ret.lines || [])) {
      returnedByProduct.set(line.productId, (returnedByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
    }
  }
  const creditPayment = normalizeSalePayments(sale).find((payment) => String(payment.method || "").toLowerCase() === "customer_credit");

  const next = updateState((draft) => {
    // Restore only net sold qty not already returned.
    for (const line of (sale.lines || [])) {
      const product = draft.products.find((item) => item.id === line.productId);
      if (!product) continue;
      const sold = Number(line.quantity || 0);
      const alreadyReturned = Number(returnedByProduct.get(line.productId) || 0);
      const netSold = Math.max(0, sold - alreadyReturned);
      product.stock = Number((Number(product.stock || 0) + netSold).toFixed(2));
    }
    if (creditPayment?.usagePlan?.length) {
      draft.customerCredits = draft.customerCredits || [];
      restoreCustomerCreditUsage({ credits: draft.customerCredits, creditPayment, saleId: sale.id });
    }
    draft.sales = (draft.sales || []).filter((item) => String(item.id) !== String(id));
    draft.returns = (draft.returns || []).filter((ret) => String(ret.saleId) !== String(id));
    return draft;
  });

  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.json({ ok: true, id: String(id) });
});

app.post("/returns", requireAuth, requireRole("cashier", "admin"), (req, res) => {
  const body = req.body || {};
  const saleId = String(body.saleId || "").trim();
  const lines = Array.isArray(body.lines) ? body.lines : [];

  if (!saleId) {
    res.status(400).json({ message: "saleId is required" });
    return;
  }
  if (!lines.length) {
    res.status(400).json({ message: "Select at least one return item" });
    return;
  }

  const state = getState();
  const sale = (state.sales || []).find((item) => String(item.id) === saleId);
  if (!sale) {
    res.status(404).json({ message: "Sale not found" });
    return;
  }
  const saleCashier = String(sale.cashier || "").trim().toLowerCase();
  const actingUser = String(req.user?.username || "").trim().toLowerCase();
  if (!saleCashier || saleCashier !== actingUser) {
    res.status(403).json({ message: "Only the rep who created this sale can return its items" });
    return;
  }

  const previousReturns = (state.returns || []).filter((item) => item.saleId === saleId);
  const returnedByProduct = new Map();
  for (const ret of previousReturns) {
    for (const line of (ret.lines || [])) {
      const key = line.productId;
      returnedByProduct.set(key, (returnedByProduct.get(key) || 0) + Number(line.quantity || 0));
    }
  }

  const undeliveredByProduct = new Map();
  for (const adjustment of (sale.deliveryAdjustments || [])) {
    for (const line of (adjustment.lines || [])) {
      const key = line.productId;
      undeliveredByProduct.set(key, (undeliveredByProduct.get(key) || 0) + Number(line.quantity || 0));
    }
  }

  const saleLineByProduct = new Map((sale.lines || []).map((line) => [line.productId, line]));
  const preparedLines = [];
  for (const incoming of lines) {
    const productId = String(incoming.productId || "").trim();
    const quantity = Number(incoming.quantity || 0);
    const condition = String(incoming.condition || "").trim().toLowerCase();
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
      res.status(400).json({ message: "Invalid return line" });
      return;
    }
    if (!["good", "damaged"].includes(condition)) {
      res.status(400).json({ message: "Return condition must be good or damaged" });
      return;
    }
    const soldLine = saleLineByProduct.get(productId);
    if (!soldLine) {
      res.status(400).json({ message: "Return item not found in selected sale" });
      return;
    }
    const soldQty = Number(soldLine.quantity || 0);
    const alreadyReturned = Number(returnedByProduct.get(productId) || 0);
    const alreadyUndelivered = Number(undeliveredByProduct.get(productId) || 0);
    const remaining = soldQty - alreadyReturned - alreadyUndelivered;
    if (quantity > remaining) {
      res.status(409).json({ message: `Return exceeds remaining qty for ${soldLine.name}` });
      return;
    }
      const financials = buildReturnLineFinancials({ sale, soldLine, quantity });
      preparedLines.push({
        productId,
        name: soldLine.name,
        quantity,
        condition,
        baseUnitPrice: financials.baseUnitPrice,
        soldUnitPrice: financials.soldUnitPrice,
        unitItemDiscount: financials.unitItemDiscount,
        itemDiscountMode: financials.itemDiscountMode,
        itemDiscountValue: financials.itemDiscountValue,
        grossAmount: financials.grossAmount,
        billDiscountShare: financials.billDiscountShare,
        returnUnitPrice: financials.returnUnitPrice,
        returnAmount: financials.returnAmount
      });
    }

    const returnTotalAmount = roundMoney(preparedLines.reduce((acc, line) => acc + Number(line.returnAmount || 0), 0));
    const record = {
      id: nanoid(12),
      saleId,
      rep: req.user.username,
      createdAt: new Date().toISOString(),
      totalAmount: returnTotalAmount,
      lines: preparedLines
    };

    const next = updateState((draft) => {
      draft.returns = draft.returns || [];
      draft.returns.unshift(record);
      for (const line of preparedLines) {
        if (line.condition !== "good") continue;
        const product = draft.products.find((item) => item.id === line.productId);
        if (product) {
          product.stock = Number((Number(product.stock || 0) + Number(line.quantity || 0)).toFixed(2));
        }
      }
      const saleIndex = (draft.sales || []).findIndex((item) => String(item.id) === saleId);
      if (saleIndex !== -1) {
        const targetSale = draft.sales[saleIndex];
        const previousRefundDue = roundMoney(Number(targetSale.refundDueAmount || 0));
        targetSale.returnedAmount = roundMoney(Number(targetSale.returnedAmount || 0) + returnTotalAmount);
        const recalculatedSale = recalculateSaleFinancials(targetSale);
        draft.sales[saleIndex] = recalculatedSale;
        const nextRefundDue = roundMoney(Number(recalculatedSale.refundDueAmount || 0));
        const newCreditAmount = roundMoney(Math.max(0, nextRefundDue - previousRefundDue));
        const customerName = String(recalculatedSale.customerName || "").trim();
        if (newCreditAmount > 0 && customerName && customerName.toLowerCase() !== "walk-in") {
          draft.customerCredits = draft.customerCredits || [];
          draft.customerCredits.unshift({
            id: nanoid(12),
            customerName,
            saleId: String(saleId),
            returnId: record.id,
            amount: newCreditAmount,
            remainingAmount: newCreditAmount,
            status: "open",
            createdAt: new Date().toISOString(),
            createdBy: req.user?.username || "system"
          });
        }
      }
      return draft;
    });

  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  res.status(201).json(record);
});

app.post("/sales/:id/delivery-adjust", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const incomingLines = Array.isArray(body.lines) ? body.lines : [];
  const markConfirmed = body.markConfirmed !== false;
  const cashReceived = Number(body.cashReceived || 0);
  const chequeAmount = Number(body.chequeAmount || 0);
  const chequeNo = String(body.chequeNo || "").trim();
  const chequeDate = String(body.chequeDate || "").trim();
  const chequeBank = String(body.chequeBank || "").trim();

  const state = getState();
  const sale = (state.sales || []).find((item) => String(item.id) === String(id));
  if (!sale) {
    res.status(404).json({ message: "Sale not found" });
    return;
  }

  const saleLines = Array.isArray(sale.lines) ? sale.lines : [];
  const soldByProduct = new Map();
  for (const line of saleLines) {
    soldByProduct.set(line.productId, (soldByProduct.get(line.productId) || 0) + Number(line.quantity || 0));
  }

  const alreadyUndelivered = new Map();
  for (const adj of (sale.deliveryAdjustments || [])) {
    for (const line of (adj.lines || [])) {
      alreadyUndelivered.set(line.productId, (alreadyUndelivered.get(line.productId) || 0) + Number(line.quantity || 0));
    }
  }

  const alreadyReturnedGood = new Map();
  for (const ret of (state.returns || [])) {
    if (String(ret.saleId) !== String(sale.id)) continue;
    for (const line of (ret.lines || [])) {
      if (String(line.condition || "").toLowerCase() !== "good") continue;
      alreadyReturnedGood.set(line.productId, (alreadyReturnedGood.get(line.productId) || 0) + Number(line.quantity || 0));
    }
  }

  const preparedLines = [];
  for (const line of incomingLines) {
    const productId = String(line.productId || "").trim();
    const quantity = Number(line.quantity || 0);
    if (!productId || !Number.isFinite(quantity) || quantity <= 0) continue;
    const sold = Number(soldByProduct.get(productId) || 0);
    if (sold <= 0) {
      res.status(400).json({ message: "Invalid delivery line product" });
      return;
    }
    const prevUndelivered = Number(alreadyUndelivered.get(productId) || 0);
    const prevReturnedGood = Number(alreadyReturnedGood.get(productId) || 0);
    const maxAllowed = Math.max(0, sold - prevUndelivered - prevReturnedGood);
    if (quantity > maxAllowed) {
      const saleLine = saleLines.find((item) => item.productId === productId);
      res.status(409).json({ message: `Undelivered qty exceeds remaining for ${saleLine?.name || productId}` });
      return;
    }
    const saleLine = saleLines.find((item) => item.productId === productId);
    preparedLines.push({
      productId,
      name: saleLine?.name || productId,
      quantity
    });
  }

  const adjustmentRecord = preparedLines.length ? {
    id: nanoid(12),
    createdAt: new Date().toISOString(),
    by: req.user?.username || "admin",
    lines: preparedLines
  } : null;

  const existingPayments = normalizeSalePayments(sale);
  if (markConfirmed) {
    if (!Number.isFinite(cashReceived) || cashReceived < 0) {
      res.status(400).json({ message: "Cash received must be 0 or more" });
      return;
    }
    if (!Number.isFinite(chequeAmount) || chequeAmount < 0) {
      res.status(400).json({ message: "Cheque amount must be 0 or more" });
      return;
    }
    if (chequeAmount > 0) {
      if (!chequeNo) {
        res.status(400).json({ message: "Cheque number is required" });
        return;
      }
      if (!chequeDate) {
        res.status(400).json({ message: "Cheque date is required" });
        return;
      }
      if (!chequeBank) {
        res.status(400).json({ message: "Cheque bank is required" });
        return;
      }
    }
    const existingPaid = totalPaymentsAmount(existingPayments);
    const incomingPaid = roundMoney(Number(cashReceived || 0) + Number(chequeAmount || 0));
    const projectedUndeliveredAmount = computeDeliveryAdjustmentsAmount(sale, adjustmentRecord ? [adjustmentRecord] : []);
    const maxCollectible = roundMoney(Math.max(0, Number(sale.total || 0) - Number(sale.returnedAmount || 0) - projectedUndeliveredAmount));
    if (incomingPaid > roundMoney(Math.max(0, maxCollectible - existingPaid))) {
        res.status(409).json({ message: "Cash and cheque total cannot exceed bill total" });
        return;
    }
  }

  const next = updateState((draft) => {
    const idx = (draft.sales || []).findIndex((item) => String(item.id) === String(id));
    if (idx === -1) return draft;
    const target = draft.sales[idx];
    target.deliveryAdjustments = target.deliveryAdjustments || [];
    if (adjustmentRecord) {
      target.deliveryAdjustments.push(adjustmentRecord);
      for (const line of adjustmentRecord.lines) {
        const product = (draft.products || []).find((item) => item.id === line.productId);
        if (!product) continue;
        product.stock = Number((Number(product.stock || 0) + Number(line.quantity || 0)).toFixed(2));
      }
    }
      if (markConfirmed) {
        const previousRefundDue = roundMoney(Number(target.refundDueAmount || 0));
        target.payments = normalizeSalePayments(target);
        if (cashReceived > 0) {
          target.payments.push({
            id: nanoid(12),
          method: "cash",
          amount: Number(cashReceived.toFixed(2)),
          createdAt: new Date().toISOString(),
          receivedBy: req.user?.username || "admin"
        });
      }
      if (chequeAmount > 0) {
        target.payments.push({
          id: nanoid(12),
          method: "cheque",
          amount: Number(chequeAmount.toFixed(2)),
          chequeNo,
          chequeDate,
          chequeBank,
          createdAt: new Date().toISOString(),
            receivedBy: req.user?.username || "admin"
          });
        }
        if (!target.deliveryConfirmedAt) {
          target.deliveryConfirmedAt = new Date().toISOString();
        }
        if (!target.deliveryConfirmedBy) {
          target.deliveryConfirmedBy = req.user?.username || "admin";
        }
        draft.sales[idx] = recalculateSaleFinancials(target);
        const recalculatedSale = draft.sales[idx];
        const nextRefundDue = roundMoney(Number(recalculatedSale.refundDueAmount || 0));
        const newCreditAmount = roundMoney(Math.max(0, nextRefundDue - previousRefundDue));
        const customerName = String(recalculatedSale.customerName || "").trim();
        if (newCreditAmount > 0 && customerName && customerName.toLowerCase() !== "walk-in") {
          draft.customerCredits = draft.customerCredits || [];
          draft.customerCredits.unshift({
            id: nanoid(12),
            customerName,
            saleId: String(id),
            returnId: "",
            amount: newCreditAmount,
            remainingAmount: newCreditAmount,
            status: "open",
            createdAt: new Date().toISOString(),
            createdBy: req.user?.username || "system",
            source: "delivery_adjustment"
          });
        }
      }
      return draft;
    });

  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, next.products);
  sendFullSync();
  const updatedSale = (next.sales || []).find((item) => String(item.id) === String(id));
  res.status(201).json(updatedSale);
});

app.get("/dashboard", requireAuth, (_req, res) => {
  const state = getState();
  const sales = (state.sales || []).map((sale) => recalculateSaleFinancials(sale));

  const today = toColomboDateKey();
  const todaySales = sales.filter((sale) => toColomboDateKey(sale.createdAt) === today);
  const todayRevenue = todaySales.reduce((acc, sale) => acc + Number(sale.total || 0), 0);
  const todayOutstanding = todaySales.reduce((acc, sale) => acc + Number(sale.outstandingAmount || 0), 0);

  const lowStockItems = state.products.filter((item) => item.stock <= 25);

  res.json({
    salesCount: sales.length,
    todaySalesCount: todaySales.length,
    todayRevenue: Number(todayRevenue.toFixed(2)),
    todayOutstanding: Number(todayOutstanding.toFixed(2)),
    lowStockItems
  });
});

app.post("/demo/reset", requireAuth, requireRole("admin"), (_req, res) => {
  if (!IS_DEMO_MODE) {
    res.status(404).json({ message: "Demo reset is available only in demo mode" });
    return;
  }

  let nextState = structuredClone(seedState);
  if (DEMO_SNAPSHOT_FILE) {
    try {
      const raw = fs.readFileSync(DEMO_SNAPSHOT_FILE, "utf8");
      nextState = JSON.parse(raw);
    } catch (error) {
      res.status(500).json({ message: `Unable to load demo snapshot: ${error?.message || "invalid snapshot"}` });
      return;
    }
  }

  const replaced = replaceState(nextState);
  io.emit(SOCKET_EVENTS.INVENTORY_UPDATED, replaced.products || []);
  sendFullSync();
  res.json({
    ok: true,
    mode: APP_MODE,
    source: DEMO_SNAPSHOT_FILE ? "snapshot" : "seed",
    sales: (replaced.sales || []).length,
    products: (replaced.products || []).length
  });
});

io.use((socket, next) => {
  const token = extractSocketToken(socket);
  if (!token) {
    next(new Error("Missing token"));
    return;
  }

  try {
    socket.data.user = verifyAccessToken(token);
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  socket.emit(SOCKET_EVENTS.STATE_SYNC, getState());
});

// Serve web client static files if built
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.join(__dirname, "../../../web/dist");

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
  console.log("Serving web client static files from", clientDistPath);
} else {
  console.log("Web client static files path not found at", clientDistPath);
}

const port = Number(process.env.PORT || 4010);
server.listen(port, () => {
  console.log(`POS API listening on http://localhost:${port}`);
});
