import express from "express";
import nodemailer from "nodemailer";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dns from "dns";
import { promisify } from "util";
import { rateLimit } from "express-rate-limit";

// ── NOTE: Remove this line in production if you have a valid SSL cert ──
// Only needed for corporate proxies or self-signed certs.
if (process.env.NODE_ENV !== "production") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const dnsLookup = promisify(dns.lookup);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────
// Allowed origins: localhost (dev) + your Vercel domain (production)
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

// Add production frontend URL from environment variable
// Set ALLOWED_ORIGIN=https://your-app.vercel.app in .env
if (process.env.ALLOWED_ORIGIN) {
  allowedOrigins.push(process.env.ALLOWED_ORIGIN);
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const isAllowed = allowedOrigins.some((allowed) => {
      if (allowed.includes("*")) {
        const regex = new RegExp("^" + allowed.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
        return regex.test(origin);
      }
      return allowed === origin;
    });

    // Also allow any *.vercel.app subdomain automatically
    if (isAllowed || origin.endsWith(".vercel.app")) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: "10mb" }));

// ── Rate Limiters ─────────────────────────────────────────────────────
const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Email rate limit exceeded. Please try again in a few minutes." },
});

const crawlerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Crawler fetch limit exceeded. Please try again later." },
});

app.use("/api/send-email", emailLimiter);
app.use("/api/call-ai", generalApiLimiter);
app.use("/api/fetch-url", crawlerLimiter);

// ── Health check (useful for monitoring) ─────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── /api/send-email ───────────────────────────────────────────────────
app.post("/api/send-email", async (req, res) => {
  const {
    smtpHost, smtpPort, smtpUser, smtpPassword,
    senderEmail, senderName, to, subject, html,
  } = req.body;

  if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword || !to || !subject || !html) {
    return res.status(400).json({ error: "Missing required SMTP credentials or email contents." });
  }

  try {
    const isSecure = parseInt(smtpPort, 10) === 465;
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort, 10),
      secure: isSecure,
      auth: { user: smtpUser, pass: smtpPassword },
      tls: {
        rejectUnauthorized: process.env.NODE_ENV === "production",
      },
    });

    const logoPath = fs.existsSync(path.join(__dirname, "public", "logo.jpg"))
      ? path.join(__dirname, "public", "logo.jpg")
      : null;

    const attachments = [];
    if (logoPath) {
      attachments.push({
        filename: "logo.jpg",
        path: logoPath,
        cid: "logo",
        contentType: "image/jpeg"
      });
    }

    const mailOptions = {
      from: `"${senderName || "Insight Flow AI"}" <${senderEmail || smtpUser}>`,
      to, subject, html, attachments
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email] Sent to ${to}: ${info.messageId}`);
    res.status(200).json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error("[Email] Error:", error);
    res.status(500).json({ error: error.message || "Failed to send email via SMTP." });
  }
});

// ── /api/call-ai ──────────────────────────────────────────────────────
app.post("/api/call-ai", async (req, res) => {
  const { provider, apiKey, systemPrompt, userPrompt, model } = req.body;

  if (!provider || !apiKey) {
    return res.status(400).json({ error: "Missing provider or API key." });
  }

  const maskedKey = apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "none";
  console.log(`[AI Proxy] ${provider} | model: ${model || "default"} | key: ${maskedKey}`);

  try {
    let responseText = "";
    let remainingRequests = "N/A";
    let remainingTokens = "N/A";

    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-2.0-flash"}:generateContent?key=${apiKey}`;
      const apiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }]
        })
      });
      const data = await apiRes.json();
      if (data?.error) {
        const errMsg = data.error.message || "Gemini error";
        const isQuota = apiRes.status === 429 || errMsg.toLowerCase().includes("exhausted") || errMsg.toLowerCase().includes("quota");
        return res.status(apiRes.status || 500).json({ error: errMsg, errType: isQuota ? "exhausted" : "invalid" });
      }
      responseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    } else if (provider === "huggingface") {
      const apiRes = await fetch("https://router.huggingface.co/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || "meta-llama/Llama-3.2-3B-Instruct",
          max_tokens: 1000,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
        })
      });
      remainingRequests = apiRes.headers.get("x-rate-limit-remaining") || "N/A";
      const data = await apiRes.json();
      if (data?.error || apiRes.status !== 200) {
        const errMsg = data?.error?.message || data?.error || "Hugging Face error";
        const isQuota = apiRes.status === 429 || errMsg.toLowerCase().includes("quota");
        return res.status(apiRes.status || 500).json({ error: errMsg, errType: isQuota ? "exhausted" : "invalid" });
      }
      responseText = data?.choices?.[0]?.message?.content || "";

    } else if (provider === "openai") {
      const apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || "gpt-4o-mini",
          max_tokens: 1000,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
        })
      });
      remainingRequests = apiRes.headers.get("x-ratelimit-remaining-requests") || "N/A";
      remainingTokens = apiRes.headers.get("x-ratelimit-remaining-tokens") || "N/A";
      const data = await apiRes.json();
      if (data?.error || apiRes.status !== 200) {
        const errMsg = data?.error?.message || "OpenAI error";
        const isQuota = apiRes.status === 429 || errMsg.toLowerCase().includes("quota");
        return res.status(apiRes.status || 500).json({ error: errMsg, errType: isQuota ? "exhausted" : "invalid" });
      }
      responseText = data?.choices?.[0]?.message?.content || "";

    } else if (provider === "groq") {
      const apiRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || "llama-3.3-70b-versatile",
          max_tokens: 1000,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
        })
      });
      remainingRequests = apiRes.headers.get("x-ratelimit-remaining-requests") || "N/A";
      remainingTokens = apiRes.headers.get("x-ratelimit-remaining-tokens") || "N/A";
      const data = await apiRes.json();
      if (data?.error || apiRes.status !== 200) {
        const errMsg = data?.error?.message || "Groq error";
        const isQuota = apiRes.status === 429 || errMsg.toLowerCase().includes("quota");
        return res.status(apiRes.status || 500).json({ error: errMsg, errType: isQuota ? "exhausted" : "invalid" });
      }
      responseText = data?.choices?.[0]?.message?.content || "";

    } else if (provider === "claude") {
      const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: model || "claude-3-5-sonnet-20241022",
          max_tokens: 1000,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      remainingRequests = apiRes.headers.get("anthropic-ratelimit-requests-remaining") || "N/A";
      remainingTokens = apiRes.headers.get("anthropic-ratelimit-tokens-remaining") || "N/A";
      const data = await apiRes.json();
      if (data?.error || apiRes.status !== 200) {
        const errMsg = data?.error?.message || "Claude error";
        const isQuota = apiRes.status === 429 || errMsg.toLowerCase().includes("quota");
        return res.status(apiRes.status || 500).json({ error: errMsg, errType: isQuota ? "exhausted" : "invalid" });
      }
      responseText = data?.content?.[0]?.text || "";

    } else {
      return res.status(400).json({ error: "Unsupported provider." });
    }

    res.status(200).json({ text: responseText, quota: { remainingRequests, remainingTokens } });
  } catch (error) {
    console.error("[AI Proxy] Error:", error);
    res.status(500).json({ error: error.message || "Failed to call AI provider.", errType: "invalid" });
  }
});

// ── /api/validate-key ─────────────────────────────────────────────────
app.post("/api/validate-key", async (req, res) => {
  const { provider, apiKey } = req.body;

  if (!provider || !apiKey) {
    return res.status(400).json({ error: "Missing provider or API key." });
  }

  try {
    let remainingRequests = "N/A";
    let remainingTokens = "N/A";

    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
      const apiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] })
      });
      const data = await apiRes.json();
      if (data?.error) {
        const errMsg = data.error.message || "Gemini validation error";
        const isQuota = apiRes.status === 429 || errMsg.toLowerCase().includes("exhausted") || errMsg.toLowerCase().includes("quota");
        return res.status(200).json({ success: false, errorType: isQuota ? "exhausted" : "invalid", message: errMsg });
      }
    } else if (provider === "huggingface") {
      const apiRes = await fetch("https://huggingface.co/api/whoami-v2", {
        headers: { "Authorization": `Bearer ${apiKey}` }
      });
      remainingRequests = apiRes.headers.get("x-rate-limit-remaining") || "N/A";
      const data = await apiRes.json();
      if (apiRes.status !== 200) {
        const errMsg = data?.error || "HuggingFace validation error";
        return res.status(200).json({ success: false, errorType: "invalid", message: errMsg });
      }
    } else if (provider === "openai") {
      const apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 1, messages: [{ role: "user", content: "ping" }] })
      });
      remainingRequests = apiRes.headers.get("x-ratelimit-remaining-requests") || "N/A";
      remainingTokens = apiRes.headers.get("x-ratelimit-remaining-tokens") || "N/A";
      const data = await apiRes.json();
      if (data?.error || apiRes.status !== 200) {
        const errMsg = data?.error?.message || "OpenAI validation error";
        const isQuota = apiRes.status === 429;
        return res.status(200).json({ success: false, errorType: isQuota ? "exhausted" : "invalid", message: errMsg });
      }
    } else if (provider === "groq") {
      const apiRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", max_tokens: 1, messages: [{ role: "user", content: "ping" }] })
      });
      remainingRequests = apiRes.headers.get("x-ratelimit-remaining-requests") || "N/A";
      remainingTokens = apiRes.headers.get("x-ratelimit-remaining-tokens") || "N/A";
      const data = await apiRes.json();
      if (data?.error || apiRes.status !== 200) {
        const errMsg = data?.error?.message || "Groq validation error";
        const isQuota = apiRes.status === 429;
        return res.status(200).json({ success: false, errorType: isQuota ? "exhausted" : "invalid", message: errMsg });
      }
    } else if (provider === "claude") {
      const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-3-5-haiku-20241022", max_tokens: 1, messages: [{ role: "user", content: "ping" }] })
      });
      remainingRequests = apiRes.headers.get("anthropic-ratelimit-requests-remaining") || "N/A";
      remainingTokens = apiRes.headers.get("anthropic-ratelimit-tokens-remaining") || "N/A";
      const data = await apiRes.json();
      if (data?.error || apiRes.status !== 200) {
        const errMsg = data?.error?.message || "Claude validation error";
        const isQuota = apiRes.status === 429;
        return res.status(200).json({ success: false, errorType: isQuota ? "exhausted" : "invalid", message: errMsg });
      }
    } else {
      return res.status(400).json({ error: "Unsupported provider." });
    }

    res.status(200).json({ success: true, quota: { remainingRequests, remainingTokens } });
  } catch (error) {
    res.status(200).json({ success: false, errorType: "invalid", message: error.message || "Failed to validate key" });
  }
});

// ── SSRF Protection Helpers ───────────────────────────────────────────
function isPrivateIP(ip) {
  if (/^(127\.|10\.|192\.168\.)/.test(ip) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) || /^169\.254\./.test(ip)) return true;
  if (ip === "::1" || ip.startsWith("fe80:") || ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd")) return true;
  return false;
}

async function validateUrlForSSRF(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname;
    if (/^[0-9.]+$/.test(hostname) || hostname.includes(":")) {
      if (isPrivateIP(hostname)) return false;
    }
    const lookupResult = await dnsLookup(hostname).catch(() => null);
    if (lookupResult?.address && isPrivateIP(lookupResult.address)) return false;
    return true;
  } catch {
    return false;
  }
}

// ── /api/fetch-url ────────────────────────────────────────────────────
app.get("/api/fetch-url", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  const isSafe = await validateUrlForSSRF(url);
  if (!isSafe) return res.status(403).json({ error: "Access forbidden (SSRF protection)." });

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) return res.status(response.status).json({ error: `Upstream status ${response.status}` });
    const html = await response.text();
    res.status(200).send(html);
  } catch (error) {
    console.error("[Proxy Fetch] Error:", error);
    res.status(500).json({ error: error.message || "Failed to fetch URL" });
  }
});

// ── /api/log ──────────────────────────────────────────────────────────
app.post("/api/log", (req, res) => {
  const { message } = req.body;
  console.log("[Client]", message);
  res.sendStatus(200);
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`InsightFlow AI backend running on port ${PORT} [${process.env.NODE_ENV || "development"}]`);
});
