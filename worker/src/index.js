/**
 * Multi Sender submission API.
 *
 * Public:
 *   POST /submit              customer submits a post (caption, media, promo
 *                              code, destination chat ids) - no bot tokens,
 *                              no repo-write credentials, nothing sensitive.
 *   GET  /promo/:code/status   check trial status before submitting (UX only)
 *   GET  /media/:id            serves a submission's media bytes - referenced
 *                              by the Item.url the bot's senders already know
 *                              how to fetch, so no sender code needs to change.
 *
 * Private (Authorization: Bearer <API_TOKEN> - the bot's GitHub Actions run):
 *   GET    /pending            list ids of not-yet-fully-delivered submissions
 *   GET    /submission/:id     full submission record
 *   DELETE /submission/:id     called once delivery to every sender succeeds
 *
 * Admin (Authorization: Bearer <ADMIN_TOKEN> - only you):
 *   POST /promo                             create/update a promo code's trial window
 *   POST /admin/register-rubika-webhook     one-time: point Rubika's servers at
 *                                            /webhook/rubika/<RUBIKA_WEBHOOK_SECRET>
 *
 * Rubika webhook (called by Rubika's servers, not a browser or the bot):
 *   POST /webhook/rubika/:secret   replies with a link to this site whenever
 *                                   someone starts or messages the Rubika bot
 *                                   directly - closes the "found the bot, no
 *                                   idea where to actually sign up" gap. :secret
 *                                   must match RUBIKA_WEBHOOK_SECRET so a random
 *                                   POST can't make the bot send messages.
 *
 * Storage: everything lives in one KV namespace.
 *   promo:<code>      -> { trial_days, first_used_at }
 *   submission:<id>   -> { caption, add_extras, media_base64, media_type, media_content_type,
 *                          destinations: {telegram_chat_id, bale_chat_id,
 *                          rubika_chat_id, eitaa_chat_id}, promo_code, created_at }
 */

const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // headroom under KV's 25MB value cap after base64 overhead

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

function requireBearer(request, expected) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  return Boolean(expected) && match && match[1] === expected;
}

async function bufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function trialStatus(promo, now) {
  if (!promo) return { valid: false, reason: "not_found" };
  if (!promo.first_used_at) {
    return { valid: true, days_left: promo.trial_days, started: false };
  }
  const elapsedDays = (now - Date.parse(promo.first_used_at)) / 86400000;
  const daysLeft = Math.ceil(promo.trial_days - elapsedDays);
  if (daysLeft <= 0) return { valid: false, reason: "expired" };
  return { valid: true, days_left: daysLeft, started: true };
}

async function handleSubmit(request, env, origin) {
  const form = await request.formData();
  const promoCode = (form.get("promo_code") || "").toString().trim();
  const caption = (form.get("caption") || "").toString().trim();
  const addExtras = (form.get("add_extras") || "").toString().trim() === "true";
  const destinations = {
    telegram_chat_id: (form.get("telegram_chat_id") || "").toString().trim(),
    bale_chat_id: (form.get("bale_chat_id") || "").toString().trim(),
    rubika_chat_id: (form.get("rubika_chat_id") || "").toString().trim(),
    eitaa_chat_id: (form.get("eitaa_chat_id") || "").toString().trim(),
  };
  const hasDestination = Object.values(destinations).some((v) => v);

  if (!promoCode) return json({ error: "کد تبلیغی الزامی است." }, 400, corsHeaders(origin));
  if (!caption && !form.get("media")) {
    return json({ error: "متن یا فایل رسانه لازم است." }, 400, corsHeaders(origin));
  }
  if (!hasDestination) {
    return json({ error: "حداقل یک مقصد (شناسه چت) را وارد کنید." }, 400, corsHeaders(origin));
  }

  const promoRaw = await env.MULTI_SENDER_KV.get(`promo:${promoCode}`);
  const promo = promoRaw ? JSON.parse(promoRaw) : null;
  const now = Date.now();
  const status = trialStatus(promo, now);
  if (!status.valid) {
    const message =
      status.reason === "expired"
        ? "دورهٔ آزمایشی شما به پایان رسیده است."
        : "کد تبلیغی نامعتبر است.";
    return json({ error: message }, 403, corsHeaders(origin));
  }
  if (!status.started) {
    promo.first_used_at = new Date(now).toISOString();
    await env.MULTI_SENDER_KV.put(`promo:${promoCode}`, JSON.stringify(promo));
  }

  let mediaBase64 = null;
  let mediaType = null;
  let mediaContentType = null;
  const mediaFile = form.get("media");
  if (mediaFile && typeof mediaFile.arrayBuffer === "function" && mediaFile.size > 0) {
    if (mediaFile.size > MAX_MEDIA_BYTES) {
      return json({ error: "حجم فایل بیش از حد مجاز است (حداکثر ۲۰ مگابایت)." }, 400, corsHeaders(origin));
    }
    mediaContentType = mediaFile.type || "application/octet-stream";
    mediaType = mediaContentType.startsWith("video/") ? "video" : "photo";
    mediaBase64 = await bufferToBase64(await mediaFile.arrayBuffer());
  }

  const id = `sub_${now}_${Math.random().toString(36).slice(2, 10)}`;
  const submission = {
    caption,
    add_extras: addExtras,
    media_base64: mediaBase64,
    media_type: mediaType,
    media_content_type: mediaContentType,
    destinations,
    promo_code: promoCode,
    created_at: new Date(now).toISOString(),
  };
  await env.MULTI_SENDER_KV.put(`submission:${id}`, JSON.stringify(submission));

  const daysLeftAfter = trialStatus(JSON.parse(await env.MULTI_SENDER_KV.get(`promo:${promoCode}`)), now).days_left;
  return json(
    { ok: true, id, days_left: daysLeftAfter, message: "پست شما ثبت شد و طی چند دقیقه آینده ارسال می‌شود." },
    200,
    corsHeaders(origin)
  );
}

async function handlePromoStatus(code, env, origin) {
  const raw = await env.MULTI_SENDER_KV.get(`promo:${code}`);
  const promo = raw ? JSON.parse(raw) : null;
  return json(trialStatus(promo, Date.now()), 200, corsHeaders(origin));
}

async function handleMedia(id, env) {
  const raw = await env.MULTI_SENDER_KV.get(`submission:${id}`);
  if (!raw) return new Response("Not found", { status: 404 });
  const submission = JSON.parse(raw);
  if (!submission.media_base64) return new Response("No media", { status: 404 });
  return new Response(base64ToBytes(submission.media_base64), {
    headers: { "Content-Type": submission.media_content_type || "application/octet-stream" },
  });
}

async function handlePending(env) {
  const list = await env.MULTI_SENDER_KV.list({ prefix: "submission:" });
  const ids = list.keys.map((k) => k.name.slice("submission:".length)).sort();
  return json({ ids });
}

async function handleGetSubmission(id, env) {
  const raw = await env.MULTI_SENDER_KV.get(`submission:${id}`);
  if (!raw) return json({ error: "not_found" }, 404);
  return json(JSON.parse(raw));
}

async function handleDeleteSubmission(id, env) {
  await env.MULTI_SENDER_KV.delete(`submission:${id}`);
  return json({ ok: true });
}

async function handleCreatePromo(request, env) {
  const body = await request.json();
  const code = (body.code || "").trim();
  const trialDays = Number(body.trial_days) || 7;
  if (!code) return json({ error: "code is required" }, 400);
  await env.MULTI_SENDER_KV.put(`promo:${code}`, JSON.stringify({ trial_days: trialDays, first_used_at: null }));
  return json({ ok: true, code, trial_days: trialDays });
}

const SITE_URL = "https://aliaslany.github.io/Multi_sender/";
const SUPPORT_URL = "https://t.me/Divarassist";
const GREETING_TEXT =
  "سلام! 👋 این‌جا ربات ارسال‌کنندهٔ MultiSender است.\n\n" +
  "برای اتصال رایگان و آزمایشیِ چند روزه و ارسال خودکار یک پست به تلگرام، بله، روبیکا و ایتا، از لینک زیر استفاده کنید:\n" +
  SITE_URL +
  "\n\nاگر کد آزمایشی ندارید، از پشتیبانی بگیرید: " +
  SUPPORT_URL;

async function rubikaApi(token, method, payload) {
  const response = await fetch(`https://botapi.rubika.ir/v3/${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json().catch(() => null);
}

async function handleRubikaWebhook(request, env, secret) {
  if (!env.RUBIKA_WEBHOOK_SECRET || secret !== env.RUBIKA_WEBHOOK_SECRET) {
    return new Response("Not found", { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: true }); // ignore malformed bodies rather than error-loop Rubika's retries
  }

  const update = body.update;
  const chatId = update && update.chat_id;
  const type = update && update.type;
  const isGreetableEvent =
    type === "StartedBot" || (type === "NewMessage" && update.new_message && update.new_message.sender_type === "User");

  if (chatId && isGreetableEvent && env.RUBIKA_BOT_TOKEN) {
    await rubikaApi(env.RUBIKA_BOT_TOKEN, "sendMessage", { chat_id: chatId, text: GREETING_TEXT });
  }

  return json({ ok: true });
}

async function handleRegisterRubikaWebhook(request, env) {
  if (!env.RUBIKA_BOT_TOKEN || !env.RUBIKA_WEBHOOK_SECRET) {
    return json({ error: "RUBIKA_BOT_TOKEN and RUBIKA_WEBHOOK_SECRET must both be set as Worker secrets first" }, 400);
  }
  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/webhook/rubika/${env.RUBIKA_WEBHOOK_SECRET}`;
  const result = await rubikaApi(env.RUBIKA_BOT_TOKEN, "updateBotEndpoints", { url: webhookUrl, type: "ReceiveUpdate" });
  return json({ ok: true, webhookUrl, rubikaResponse: result });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      return handleSubmit(request, env, origin);
    }

    const promoStatusMatch = url.pathname.match(/^\/promo\/([^/]+)\/status$/);
    if (request.method === "GET" && promoStatusMatch) {
      return handlePromoStatus(decodeURIComponent(promoStatusMatch[1]), env, origin);
    }

    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
    if (request.method === "GET" && mediaMatch) {
      return handleMedia(mediaMatch[1], env);
    }

    // Everything below is server-to-server only (the bot, or you).
    const submissionMatch = url.pathname.match(/^\/submission\/([^/]+)$/);

    if (request.method === "GET" && url.pathname === "/pending") {
      if (!requireBearer(request, env.API_TOKEN)) return unauthorized();
      return handlePending(env);
    }
    if (request.method === "GET" && submissionMatch) {
      if (!requireBearer(request, env.API_TOKEN)) return unauthorized();
      return handleGetSubmission(submissionMatch[1], env);
    }
    if (request.method === "DELETE" && submissionMatch) {
      if (!requireBearer(request, env.API_TOKEN)) return unauthorized();
      return handleDeleteSubmission(submissionMatch[1], env);
    }
    if (request.method === "POST" && url.pathname === "/promo") {
      if (!requireBearer(request, env.ADMIN_TOKEN)) return unauthorized();
      return handleCreatePromo(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/register-rubika-webhook") {
      if (!requireBearer(request, env.ADMIN_TOKEN)) return unauthorized();
      return handleRegisterRubikaWebhook(request, env);
    }

    const rubikaWebhookMatch = url.pathname.match(/^\/webhook\/rubika\/([^/]+)$/);
    if (request.method === "POST" && rubikaWebhookMatch) {
      return handleRubikaWebhook(request, env, rubikaWebhookMatch[1]);
    }

    return json({ error: "not_found" }, 404);
  },
};
