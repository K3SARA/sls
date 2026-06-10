const fallbackHost =
  typeof window !== "undefined" && window.location?.hostname
    ? window.location.hostname
    : "localhost";

const API_BASE = typeof import.meta.env.VITE_API_BASE === "string"
  ? import.meta.env.VITE_API_BASE
  : `http://${fallbackHost}:4010`;

let accessToken = "";
let refreshToken = "";
let onSessionRefresh = () => {};
let onSessionInvalid = () => {};
let refreshPromise = null;

export const getApiBase = () => API_BASE;
export const getAccessToken = () => accessToken;

export const setAuthSession = (session) => {
  accessToken = session?.accessToken || "";
  refreshToken = session?.refreshToken || "";
};

export const clearAuthSession = () => {
  accessToken = "";
  refreshToken = "";
};

export const setAuthCallbacks = ({ onRefresh, onInvalid }) => {
  onSessionRefresh = onRefresh || (() => {});
  onSessionInvalid = onInvalid || (() => {});
};

const rawRequest = async (path, init = {}) => {
  const response = await fetch(`${API_BASE}${path}`, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    const error = new Error(body.message || `Request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return body;
};

const refreshAccessToken = async () => {
  if (!refreshToken) throw new Error("No refresh token");
  if (!refreshPromise) {
    refreshPromise = rawRequest("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken })
    }).then((session) => {
      setAuthSession(session);
      onSessionRefresh(session);
      return session;
    }).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
};

const request = async (path, init = {}, retry = true) => {
  const headers = {
    "Content-Type": "application/json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(init.headers || {})
  };

  try {
    return await rawRequest(path, { ...init, headers });
  } catch (error) {
    const isAuthError = error.status === 401;
    const canRefresh = retry && isAuthError && refreshToken && path !== "/auth/login" && path !== "/auth/refresh";
    if (!canRefresh) throw error;

    try {
      await refreshAccessToken();
      return await request(path, init, false);
    } catch {
      clearAuthSession();
      onSessionInvalid();
      throw error;
    }
  }
};

export const loginApi = (payload) =>
  rawRequest("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

export const logoutApi = () =>
  rawRequest("/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken })
  }).catch(() => ({ ok: true }));

export const fetchMe = () => request("/auth/me");
export const fetchAuthUsers = () => request("/auth/users");
export const createAuthUser = (payload) =>
  request("/auth/users", {
    method: "POST",
    body: JSON.stringify(payload)
  });
export const updateAuthUser = (id, payload) =>
  request(`/auth/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
export const deleteAuthUser = (id) =>
  request(`/auth/users/${id}`, {
    method: "DELETE"
  });
export const fetchState = () => request("/state");
export const fetchDashboard = () => request("/dashboard");
export const fetchAppConfig = () => request("/app/config");
export const submitSale = (payload) =>
  request("/sales", {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const patchSale = (id, payload) =>
  request(`/sales/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

export const deleteSale = (id) =>
  request(`/sales/${id}`, {
    method: "DELETE"
  });

export const submitDeliveryAdjustment = (id, payload) =>
  request(`/sales/${id}/delivery-adjust`, {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const submitReturn = (payload) =>
  request("/returns", {
    method: "POST",
    body: JSON.stringify(payload)
  });
export const patchProduct = (id, payload) =>
  request(`/products/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

export const createProduct = (payload) =>
  request("/products", {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const deleteProduct = (id) =>
  request(`/products/${id}`, {
    method: "DELETE"
  });

export const createCustomer = (payload) =>
  request("/customers", {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const updateCustomer = (id, payload) =>
  request(`/customers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });

export const createStaff = (payload) =>
  request("/staff", {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const updateStaff = (id, payload) =>
  request(`/staff/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
export const deleteStaff = (id) =>
  request(`/staff/${id}`, {
    method: "DELETE"
  });

export const resetLorryCount = () =>
  request("/settings/lorry-count-reset", {
    method: "POST"
  });

export const setLoadingRowMark = (payload) =>
  request("/settings/loading-row-mark", {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const setManagerFullAccess = (payload) =>
  request("/settings/manager-full-access", {
    method: "POST",
    body: JSON.stringify(payload)
  });

export const resetDemoData = () =>
  request("/demo/reset", {
    method: "POST"
  });
