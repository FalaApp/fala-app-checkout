const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");

const app = express();
const PORT = process.env.PORT || 3000;
const ASAAS_BASE_URL = process.env.ASAAS_BASE_URL || "https://api-sandbox.asaas.com/v3";
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const FALA_APP_API_URL = process.env.FALA_APP_API_URL || "https://api.fala.app.br";

const FREE_TRIAL_WEBHOOK =
  process.env.FREE_TRIAL_WEBHOOK ||
  "https://make.fala.app.br/webhook/a5984e82-da61-4e83-8fcf-001c44b48c35";

const FREE_TRIAL_DEFAULTS = {
  group: "120363227948093356@g.us",
  apiUrl: "https://api.fala.app.br",
  sessionId: "a23483ce-62e2-439f-b04d-b9eb472a7ea2",
  moduleIds: [
    "15b1c32f-356c-4366-86f3-81df99b30276",
    "5deb010e-6c51-44aa-be20-9d186fe54ea0",
    "e60b0076-aba3-4fd9-92f8-d5833dfb2141",
    "bb496245-73f4-4ac9-a0ea-b272bf0ea284",
    "29dadefa-f954-4d0e-8462-471bf1239863",
    "21709f76-b32f-4fee-9c8d-4d4b584ce51c",
    "77a701d3-f0df-4af2-bffa-193c37c02d17",
  ],
};

const PLANS = {
  small: {
    id: "small",
    name: "Plano Small",
    value: 247.0,
    firstMonthValue: 29.9,
    description: "FalaApp · Plano Small (120k palavras · 7.500 disparos)",
  },
  smart: {
    id: "smart",
    name: "Plano Smart",
    value: 447.0,
    description: "FalaApp · Plano Smart (240k palavras · 15.000 disparos)",
  },
  scale: {
    id: "scale",
    name: "Plano Scale",
    value: 747.0,
    description: "FalaApp · Plano Scale (500k palavras · 30.000 disparos)",
  },
};

app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "7d" }));
app.use(express.static(path.join(__dirname)));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

function parseHumanDuration(str) {
  const match = String(str).match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) return 12 * 60 * 60 * 1000;
  const n = parseInt(match[1]);
  const unit = match[2] || 's';
  const map = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return n * (map[unit] || 1000);
}

// ── Admin auth middleware ────────────────────────────────────────────────────

async function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ error: "Não autenticado" });
  try {
    const r = await fetch(`${FALA_APP_API_URL}/own/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error("profile_error");
    const body = await r.json();
    const user = body?.data ?? body;
    const isAdmin = user?.roles?.some((rl) => rl?.role?.name === "admin");
    if (!isAdmin) throw new Error("not_admin");
    req.adminUser = user;
    next();
  } catch (e) {
    res.clearCookie("admin_token");
    return res.status(403).json({ error: "Acesso negado" });
  }
}

async function apiProxy(req, res, method, path, body) {
  const token = req.cookies?.admin_token;
  const url = `${FALA_APP_API_URL}${path}`;
  try {
    const r = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("[proxy]", method, url, e.message);
    return res.status(502).json({ error: "Erro ao contatar a API" });
  }
}

// ── Admin routes ─────────────────────────────────────────────────────────────

app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "admin", "index.html"))
);

app.post("/api/admin/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "E-mail e senha obrigatórios" });
  try {
    const r = await fetch(`${FALA_APP_API_URL}/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: body?.message || "Credenciais inválidas" });

    // sign-in retorna { message, data: { token, expiresIn, ... } }
    const data = body.data ?? body;
    const expiresIn = data.expiresIn ?? "12h";
    const expiresMs = typeof expiresIn === "number"
      ? expiresIn * 1000
      : parseHumanDuration(expiresIn);
    res.cookie("admin_token", data.token, {
      httpOnly: true,
      path: "/",
      maxAge: expiresMs || 12 * 60 * 60 * 1000,
      sameSite: "lax",
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: "Erro ao autenticar" });
  }
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("admin_token");
  return res.json({ ok: true });
});

// Quotes CRUD (admin)
app.get("/api/admin/quotes", requireAdmin, (req, res) =>
  apiProxy(req, res, "GET", "/quotes")
);
app.get("/api/admin/quotes/:id", requireAdmin, (req, res) =>
  apiProxy(req, res, "GET", `/quotes/${req.params.id}`)
);
app.post("/api/admin/quotes", requireAdmin, (req, res) =>
  apiProxy(req, res, "POST", "/quotes", req.body)
);
app.patch("/api/admin/quotes/:id", requireAdmin, (req, res) =>
  apiProxy(req, res, "PATCH", `/quotes/${req.params.id}`, req.body)
);
app.delete("/api/admin/quotes/:id", requireAdmin, (req, res) =>
  apiProxy(req, res, "DELETE", `/quotes/${req.params.id}`)
);

// ── Public quote routes ───────────────────────────────────────────────────────

app.get("/orcamento/:token", (_req, res) =>
  res.sendFile(path.join(__dirname, "orcamento.html"))
);

app.get("/api/orcamento/:token", async (req, res) => {
  try {
    const r = await fetch(`${FALA_APP_API_URL}/quotes/public/${req.params.token}`);
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: "Erro ao obter orçamento" });
  }
});

app.post("/api/orcamento/:token/pagar", async (req, res) => {
  const token = req.params.token;
  const { clientName, cpfCnpj, clientEmail, clientPhone,
          postalCode, address, addressNumber, province, city, state } = req.body || {};
  if (!clientName) return res.status(400).json({ error: "Nome obrigatório" });
  const cpf = cleanDigits(cpfCnpj);
  if (cpf.length !== 11 && cpf.length !== 14) return res.status(400).json({ error: "CPF/CNPJ inválido" });
  const phone = cleanDigits(clientPhone);
  if (phone.length < 10) return res.status(400).json({ error: "WhatsApp inválido" });
  if (!postalCode || cleanDigits(postalCode).length !== 8) return res.status(400).json({ error: "CEP inválido" });
  if (!address) return res.status(400).json({ error: "Logradouro obrigatório" });

  try {
    // 1. Buscar e validar o orçamento
    const qr = await fetch(`${FALA_APP_API_URL}/quotes/public/${token}`);
    const qBody = await qr.json();
    const quote = qBody?.data ?? qBody;
    if (!qr.ok || !quote) return res.status(404).json({ error: "Orçamento não encontrado" });
    if (quote.status !== "DRAFT" && quote.status !== "SENT")
      return res.status(400).json({ error: "Este orçamento já foi processado" });
    if (quote.validUntil && new Date(quote.validUntil) < new Date())
      return res.status(400).json({ error: "Este orçamento está expirado" });

    // 2. Criar cliente no Asaas
    const customer = await asaas("POST", "/customers", {
      name: clientName.trim(),
      cpfCnpj: cpf,
      email: clientEmail?.trim() || undefined,
      mobilePhone: phone.startsWith("55") ? phone : `55${phone}`,
      postalCode: cleanDigits(postalCode),
      address: address?.trim(),
      addressNumber: addressNumber?.trim() || "S/N",
      province: province?.trim() || undefined,
      notificationDisabled: false,
      externalReference: `falaapp-quote-${token}`,
    });

    // 3. Criar assinatura
    const recurringTotal = quote.recurringTotal || 0;
    const onceTotal = quote.onceTotal || 0;
    const gross = recurringTotal + onceTotal;
    const disc = quote.discount;
    const discScope = disc?.scope ?? "first_only";
    let discAmt = 0;
    if (disc?.value > 0) {
      discAmt = disc.type === "percent" ? (gross * disc.value / 100) : disc.value;
      discAmt = Math.min(discAmt, gross);
    }

    // permanent: discount splits proportionally — recurring rate is reduced forever
    // first_only: subscription at full recurring rate; only 1ª fatura gets the discount
    let subscriptionValue, firstMonthValue;
    if (discScope === "permanent") {
      subscriptionValue = gross > 0 ? Math.max(0, recurringTotal - discAmt * (recurringTotal / gross)) : recurringTotal;
      const oncePart = gross > 0 ? Math.max(0, onceTotal - discAmt * (onceTotal / gross)) : onceTotal;
      firstMonthValue = Math.round((subscriptionValue + oncePart) * 100) / 100;
      subscriptionValue = Math.round(subscriptionValue * 100) / 100;
    } else {
      subscriptionValue = recurringTotal;
      firstMonthValue = Math.round((gross - discAmt) * 100) / 100;
    }

    const items = Array.isArray(quote.items) ? quote.items : [];
    const descParts = items.map(i => `${i.quantity}x ${i.description}`).join(", ");

    const subscription = await asaas("POST", "/subscriptions", {
      customer: customer.id,
      billingType: "UNDEFINED",
      value: subscriptionValue || firstMonthValue,
      nextDueDate: isoTomorrow(),
      cycle: "MONTHLY",
      description: `FalaApp — ${quote.title || "Proposta"}: ${descParts}`,
      externalReference: `falaapp-quote-${token}`,
    });

    // 4. Ajustar 1ª fatura se houver avulsos
    let invoiceUrl = null;
    try {
      const list = await asaas("GET", `/subscriptions/${subscription.id}/payments?limit=1`);
      const firstPayment = list?.data?.[0] || null;
      if (firstPayment) {
        if (firstMonthValue !== recurringTotal) {
          const onceItems = items.filter(i => i.billing === "once");
          const extraParts = [];
          if (onceItems.length > 0) extraParts.push(onceItems.map(i => `${i.quantity}x ${i.description}`).join(", "));
          if (discAmt > 0) extraParts.push(`desconto R$ ${discAmt.toFixed(2)}`);
          const updated = await asaas("PUT", `/payments/${firstPayment.id}`, {
            value: firstMonthValue,
            description: `FalaApp — ${quote.title}: 1ª mensalidade${extraParts.length ? ` + ${extraParts.join(" | ")}` : ""}`,
          });
          invoiceUrl = updated.invoiceUrl || null;
        } else {
          invoiceUrl = firstPayment.invoiceUrl || null;
        }
      }
    } catch (e) {
      console.error("[pagar] falha ao ajustar 1ª fatura:", e.message);
    }

    // 5. Marcar orçamento como aceito na API
    const acceptUrl = `${FALA_APP_API_URL}/quotes/public/${token}/accept`;
    const ar = await fetch(acceptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientName: clientName.trim(),
        clientEmail: clientEmail?.trim() || undefined,
        clientPhone: phone || undefined,
        asaasCustomerId: customer.id,
        asaasSubscriptionId: subscription.id,
        asaasSubscriptionUrl: invoiceUrl,
      }),
    });
    if (!ar.ok) {
      const errText = await ar.text();
      console.error("[pagar] accept error:", ar.status, errText.slice(0, 300));
    }

    return res.json({ ok: true, primaryUrl: invoiceUrl });
  } catch (e) {
    console.error("[pagar] error:", e.message);
    return res.status(502).json({ error: e.message || "Erro ao processar pagamento" });
  }
});

async function asaas(method, endpoint, body) {
  const res = await fetch(`${ASAAS_BASE_URL}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      access_token: ASAAS_API_KEY,
      "User-Agent": "fala-app-checkout",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Asaas retornou resposta inválida (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg = data?.errors?.[0]?.description || data?.message || `HTTP ${res.status}`;
    throw new Error(`Asaas ${method} ${endpoint}: ${msg}`);
  }
  return data;
}

function isoTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function cleanDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

function validPayload(b) {
  if (!b || typeof b !== "object") return "Payload inválido";
  if (!b.planId || !PLANS[b.planId]) return "Plano inválido";
  if (!b.name || b.name.trim().length < 2) return "Nome obrigatório";
  const cpf = cleanDigits(b.cpfCnpj);
  if (cpf.length !== 11 && cpf.length !== 14) return "CPF/CNPJ inválido";
  const phone = cleanDigits(b.mobilePhone);
  if (phone.length < 10) return "Telefone inválido";
  if (!b.postalCode || cleanDigits(b.postalCode).length !== 8) return "CEP inválido";
  if (!b.address) return "Logradouro obrigatório";
  if (!b.city) return "Cidade obrigatória";
  if (!b.state) return "Estado obrigatório";
  return null;
}

app.post("/api/create-subscription", async (req, res) => {
  if (!ASAAS_API_KEY) {
    return res.status(500).json({ error: "ASAAS_API_KEY não configurada no servidor" });
  }

  const err = validPayload(req.body);
  if (err) return res.status(400).json({ error: err });

  const plan = PLANS[req.body.planId];
  const cpfCnpj = cleanDigits(req.body.cpfCnpj);
  const mobilePhone = cleanDigits(req.body.mobilePhone);

  try {
    const customer = await asaas("POST", "/customers", {
      name: req.body.name.trim(),
      cpfCnpj,
      email: req.body.email?.trim() || undefined,
      mobilePhone,
      postalCode: cleanDigits(req.body.postalCode),
      address: req.body.address?.trim(),
      province: req.body.province?.trim() || undefined,
      addressNumber: req.body.addressNumber?.trim() || "S/N",
      notificationDisabled: false,
      externalReference: `falaapp-${Date.now()}`,
    });

    const subscription = await asaas("POST", "/subscriptions", {
      customer: customer.id,
      billingType: "UNDEFINED",
      value: plan.value,
      nextDueDate: isoTomorrow(),
      cycle: "MONTHLY",
      description: plan.description,
      externalReference: `falaapp-${plan.id}-${customer.id}`,
    });

    let firstPayment = null;
    try {
      const list = await asaas("GET", `/subscriptions/${subscription.id}/payments?limit=1`);
      firstPayment = list?.data?.[0] || null;

      if (firstPayment && plan.firstMonthValue && plan.firstMonthValue !== plan.value) {
        const updated = await asaas("PUT", `/payments/${firstPayment.id}`, {
          value: plan.firstMonthValue,
          description: `${plan.description} · 1º mês promocional`,
        });
        firstPayment = updated;
      }
    } catch (e) {
      console.error("[asaas] Falha ao ajustar 1ª cobrança:", e.message);
    }

    return res.json({
      ok: true,
      customerId: customer.id,
      subscriptionId: subscription.id,
      invoiceUrl: firstPayment?.invoiceUrl || null,
      bankSlipUrl: firstPayment?.bankSlipUrl || null,
    });
  } catch (e) {
    console.error("[create-subscription]", e);
    return res.status(502).json({ error: e.message || "Erro ao criar assinatura no Asaas" });
  }
});

app.post("/api/free-trial", async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim();
  const phone = cleanDigits(b.phone);

  if (name.length < 2) return res.status(400).json({ error: "Nome obrigatório" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "E-mail inválido" });
  if (phone.length < 10) return res.status(400).json({ error: "Telefone inválido" });

  const payload = {
    name,
    email,
    phone: phone.startsWith("55") ? phone : `55${phone}`,
    ...FREE_TRIAL_DEFAULTS,
  };

  try {
    const r = await fetch(FREE_TRIAL_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error("[free-trial] webhook non-2xx:", r.status, text.slice(0, 300));
      return res.status(502).json({ error: `Webhook retornou ${r.status}` });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("[free-trial]", e);
    return res.status(502).json({ error: "Falha ao contatar o webhook" });
  }
});

app.listen(PORT, () => {
  console.log(`fala-app-checkout rodando em http://0.0.0.0:${PORT}`);
  console.log(`Asaas base: ${ASAAS_BASE_URL}`);
  if (!ASAAS_API_KEY) console.warn("⚠  ASAAS_API_KEY não definida");
});
