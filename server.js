const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ASAAS_BASE_URL = process.env.ASAAS_BASE_URL || "https://api-sandbox.asaas.com/v3";
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

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
app.use(express.static(path.join(__dirname, "public"), { maxAge: "7d" }));
app.use(express.static(path.join(__dirname)));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

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
