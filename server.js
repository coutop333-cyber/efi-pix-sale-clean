require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

const EFI_CLIENT_ID = process.env.EFI_CLIENT_ID;
const EFI_CLIENT_SECRET = process.env.EFI_CLIENT_SECRET;
const EFI_PIX_KEY = process.env.EFI_PIX_KEY;
const EFI_CERT_BASE64 = process.env.EFI_CERT_BASE64;
const EFI_RELAY_SECRET = process.env.EFI_RELAY_SECRET;

const SITE_WEBHOOK_URL =
  process.env.SITE_WEBHOOK_URL ||
  "https://casacosmeticos.sale/api/public/efi-pago";

const PUBLIC_PROXY_URL =
  process.env.PUBLIC_PROXY_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "";

const WEBHOOK_URL =
  process.env.EFI_WEBHOOK_URL ||
  `${PUBLIC_PROXY_URL}/efi-webhook`;

const EFI_BASE_URL =
  process.env.EFI_BASE_URL ||
  "https://pix.api.efipay.com.br";

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function fail(message) {
  throw new Error(message);
}

function requiredEnv() {
  const missing = [];

  if (!EFI_CLIENT_ID) missing.push("EFI_CLIENT_ID");
  if (!EFI_CLIENT_SECRET) missing.push("EFI_CLIENT_SECRET");
  if (!EFI_PIX_KEY) missing.push("EFI_PIX_KEY");
  if (!EFI_CERT_BASE64) missing.push("EFI_CERT_BASE64");
  if (!EFI_RELAY_SECRET) missing.push("EFI_RELAY_SECRET");
  if (!SITE_WEBHOOK_URL) missing.push("SITE_WEBHOOK_URL");
  if (!PUBLIC_PROXY_URL) missing.push("PUBLIC_PROXY_URL ou RENDER_EXTERNAL_URL");

  if (missing.length) {
    fail(`Variáveis ausentes: ${missing.join(", ")}`);
  }
}

function getCertificatePath() {
  requiredEnv();

  const certPath = path.join("/tmp", "efi-certificate.p12");

  if (!fs.existsSync(certPath)) {
    const cleanBase64 = EFI_CERT_BASE64.replace(/\s/g, "");
    const buffer = Buffer.from(cleanBase64, "base64");

    fs.writeFileSync(certPath, buffer);

    log("[cert] certificado base64 carregado em:", certPath);
    log("[cert] tamanho bytes:", buffer.length);
  }

  return certPath;
}

function createHttpsAgent() {
  const certPath = getCertificatePath();

  return new https.Agent({
    pfx: fs.readFileSync(certPath),
    passphrase: "",
    rejectUnauthorized: true,
  });
}

function basicAuthHeader() {
  const credentials = `${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

async function getAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && tokenCache.expiresAt > now + 30000) {
    return tokenCache.accessToken;
  }

  const httpsAgent = createHttpsAgent();

  log("[oauth] solicitando token Efí");

  const response = await axios.post(
    `${EFI_BASE_URL}/oauth/token`,
    {
      grant_type: "client_credentials",
    },
    {
      httpsAgent,
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  tokenCache.accessToken = response.data.access_token;
  tokenCache.expiresAt =
    Date.now() + Number(response.data.expires_in || 3000) * 1000;

  log("[oauth] token Efí autenticado");

  return tokenCache.accessToken;
}

function gerarTxid() {
  return crypto.randomBytes(16).toString("hex");
}

function formatarValor(valor) {
  const n = Number(valor);

  if (!Number.isFinite(n) || n <= 0) {
    fail("Valor inválido");
  }

  return n.toFixed(2);
}

async function efiRequest(method, url, data, extraHeaders = {}) {
  const token = await getAccessToken();
  const httpsAgent = createHttpsAgent();

  const response = await axios({
    method,
    url: `${EFI_BASE_URL}${url}`,
    data,
    httpsAgent,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    log("[efi] erro:", response.status, JSON.stringify(response.data));
    const err = new Error("Erro Efí");
    err.response = response;
    throw err;
  }

  return response.data;
}

async function registrarWebhook() {
  requiredEnv();

  log("[webhook] registrando:", WEBHOOK_URL);

  const result = await efiRequest(
    "put",
    `/v2/webhook/${encodeURIComponent(EFI_PIX_KEY)}`,
    {
      webhookUrl: WEBHOOK_URL,
    },
    {
      "x-skip-mtls-checking": "true",
    }
  );

  log("[webhook] registrado com sucesso:", JSON.stringify(result));

  return result;
}

async function consultarWebhook() {
  return efiRequest(
    "get",
    `/v2/webhook/${encodeURIComponent(EFI_PIX_KEY)}`
  );
}

async function enviarParaLovable(payload) {
  const body = {
    txid: payload.txid,
    valor: payload.valor,
    status: "paid",
    secret: EFI_RELAY_SECRET,
  };

  if (payload.pedidoId) {
    body.pedidoId = payload.pedidoId;
    body.external_reference = payload.pedidoId;
  }

  if (payload.external_reference && !body.external_reference) {
    body.external_reference = payload.external_reference;
  }

  log("[relay] enviando para:", SITE_WEBHOOK_URL);
  log("[relay] body:", JSON.stringify(body, null, 2));

  const response = await axios.post(SITE_WEBHOOK_URL, body, {
    headers: {
      "Content-Type": "application/json",
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  log("[relay] resposta status:", response.status);
  log("[relay] resposta body:", JSON.stringify(response.data));

  return {
    status: response.status,
    data: response.data,
  };
}

async function processarWebhook(req, res) {
  try {
    log("[efi-webhook] recebido em:", req.originalUrl);
    log("[efi-webhook] body:", JSON.stringify(req.body, null, 2));

    const pixList = Array.isArray(req.body?.pix) ? req.body.pix : [];

    if (!pixList.length) {
      log("[efi-webhook] sem pix no payload");
      return res.status(200).json({ ok: true, message: "sem pix" });
    }

    for (const pix of pixList) {
      const txid = pix.txid;
      const valor = pix.valor;

      log("[efi-webhook] txid:", txid);
      log("[efi-webhook] valor:", valor);

      if (!txid) {
        log("[efi-webhook] pix sem txid, ignorando");
        continue;
      }

      await enviarParaLovable({
        txid,
        valor,
        status: "paid",
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    log("[efi-webhook] erro:", error.message);
    log("[efi-webhook] detalhes:", JSON.stringify(error.response?.data || {}));

    return res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null,
    });
  }
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "efi-pix-sale-clean",
    webhookUrl: WEBHOOK_URL,
    relayUrl: SITE_WEBHOOK_URL,
    efiBaseUrl: EFI_BASE_URL,
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
  });
});

app.get("/admin/register-webhook", async (req, res) => {
  try {
    const result = await registrarWebhook();

    res.json({
      ok: true,
      webhookUrl: WEBHOOK_URL,
      result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null,
    });
  }
});

app.post("/admin/register-webhook", async (req, res) => {
  try {
    const result = await registrarWebhook();

    res.json({
      ok: true,
      webhookUrl: WEBHOOK_URL,
      result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null,
    });
  }
});

app.get("/admin/check-webhook", async (req, res) => {
  try {
    const result = await consultarWebhook();

    res.json({
      ok: true,
      result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      details: error.response?.data || null,
    });
  }
});

app.post("/create-pix", async (req, res) => {
  try {
    requiredEnv();

    log("[create-pix] body:", JSON.stringify(req.body, null, 2));

    const valor = req.body.valor || req.body.amount || req.body.total;
    const pedidoId =
      req.body.pedidoId ||
      req.body.external_reference ||
      req.body.reference ||
      req.body.orderId;

    if (!valor) {
      return res.status(400).json({
        error: true,
        message: "Valor obrigatório",
      });
    }

    if (!pedidoId) {
      return res.status(400).json({
        error: true,
        message: "pedidoId/external_reference obrigatório",
      });
    }

    const txid = gerarTxid();
    const valorFormatado = formatarValor(valor);

    const cobranca = await efiRequest(
      "put",
      `/v2/cob/${txid}`,
      {
        calendario: {
          expiracao: 3600,
        },
        valor: {
          original: valorFormatado,
        },
        chave: EFI_PIX_KEY,
        solicitacaoPagador: `Pedido ${pedidoId}`,
        infoAdicionais: [
          {
            nome: "pedidoId",
            valor: String(pedidoId).slice(0, 72),
          },
        ],
      }
    );

    log("[create-pix] cobrança criada:", JSON.stringify(cobranca));

    const locId = cobranca?.loc?.id;

    if (!locId) {
      throw new Error("Efí não retornou loc.id");
    }

    const qr = await efiRequest("get", `/v2/loc/${locId}/qrcode`);

    log("[create-pix] qrcode gerado para txid:", txid);

    return res.json({
      success: true,
      provider: "efi",
      status: "pending",
      pedidoId,
      external_reference: pedidoId,
      txid,
      efi_txid: txid,
      locId,
      valor: valorFormatado,
      qrCodeImage: qr.imagemQrcode,
      pixCopiaECola: qr.qrcode,
      expiresIn: 3600,
    });
  } catch (error) {
    log("[create-pix] erro:", error.message);
    log("[create-pix] detalhes:", JSON.stringify(error.response?.data || {}));

    return res.status(500).json({
      error: true,
      message: error.message,
      details: error.response?.data || null,
    });
  }
});

// GET /check-payment/:txid - Backup para confirmação de pagamento Efí
app.get("/check-payment/:txid", async (req, res) => {
  const { txid } = req.params;

  try {
    log("[check-payment] consultando Efí:", txid);

    const cob = await efiRequest("get", `/v2/cob/${txid}`);

    log("[check-payment] status Efí:", JSON.stringify({
      txid,
      status: cob?.status,
      valor: cob?.valor?.original,
      solicitacaoPagador: cob?.solicitacaoPagador,
    }));

    if (cob?.status === "CONCLUIDA") {
      const valor =
        cob?.valor?.original ||
        cob?.pix?.[0]?.valor ||
        null;

      const externalReference =
        typeof cob?.solicitacaoPagador === "string"
          ? cob.solicitacaoPagador.replace(/^Pedido\s+/i, "").trim()
          : null;

      log("[check-payment] pagamento confirmado, fazendo relay:", JSON.stringify({
        txid,
        valor,
        externalReference,
      }));

      const relay = await enviarParaLovable({
        txid,
        valor,
        status: "paid",
        external_reference: externalReference,
        pedidoId: externalReference,
      });

      log("[check-payment] relay enviado:", JSON.stringify({
        txid,
        relayStatus: relay.status,
      }));

      return res.json({
        paid: true,
        status: "CONCLUIDA",
        txid,
        valor,
        external_reference: externalReference,
        relayed: relay.status >= 200 && relay.status < 300,
        relayStatus: relay.status,
        relayBody: relay.data,
      });
    }

    log("[check-payment] pagamento pendente:", JSON.stringify({
      txid,
      status: cob?.status,
    }));

    return res.json({
      paid: false,
      status: cob?.status || "pending",
      txid,
      valor: cob?.valor?.original || null,
    });
  } catch (error) {
    log("[check-payment] erro:", error.message);
    log("[check-payment] detalhes:", JSON.stringify(error.response?.data || {}));

    return res.status(500).json({
      paid: false,
      status: "error",
      txid,
      error: error.message,
      details: error.response?.data || null,
    });
  }
});

app.post("/efi-webhook", processarWebhook);
app.post("/efi-webhook/pix", processarWebhook);

app.get("/efi-webhook", (req, res) => {
  log("[efi-webhook] GET validação:", JSON.stringify(req.query));
  res.status(200).json({ ok: true });
});

app.get("/efi-webhook/pix", (req, res) => {
  log("[efi-webhook/pix] GET validação:", JSON.stringify(req.query));
  res.status(200).json({ ok: true });
});

app.listen(PORT, async () => {
  log(`Servidor rodando na porta ${PORT}`);
  log("[config] WEBHOOK_URL:", WEBHOOK_URL);
  log("[config] SITE_WEBHOOK_URL:", SITE_WEBHOOK_URL);

  try {
    getCertificatePath();
    log("[startup] certificado carregado");
  } catch (error) {
    log("[startup] erro certificado/env:", error.message);
  }
});
