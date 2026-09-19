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
 *   POST /admin/register-telegram-webhook    one-time: setWebhook for the support
 *                                            bot, asking for business_* updates
 *
 * Rubika webhook (called by Rubika's servers, not a browser or the bot):
 *   POST /webhook/rubika/:secret   replies with a link to this site whenever
 *                                   someone starts or messages the Rubika bot
 *                                   directly - closes the "found the bot, no
 *                                   idea where to actually sign up" gap. :secret
 *                                   must match RUBIKA_WEBHOOK_SECRET so a random
 *                                   POST can't make the bot send messages.
 *
 * Telegram Business webhook (called by Telegram's servers):
 *   POST /webhook/telegram         rule-based auto-replies in your own DMs, sent
 *                                   as you, for the support bot attached to your
 *                                   profile's Chat Automation. Authenticated by
 *                                   the X-Telegram-Bot-Api-Secret-Token header
 *                                   (must equal TELEGRAM_WEBHOOK_SECRET).
 *
 * Storage: everything lives in one KV namespace.
 *   promo:<code>      -> { trial_days, first_used_at }
 *   bizconn:<id>      -> { owner_id, can_reply } for a Telegram Business connection
 *   bizauto:<chat_id> -> "1" once the auto-responder has spoken in that chat
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

async function telegramApi(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json().catch(() => null);
}

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

// ---------------------------------------------------------------------------
// Telegram Business ("Chat Automation") auto-responder.
//
// Telegram Premium lets you attach a bot to your personal account, which then
// sees your DMs and can answer *as you*. This one is deliberately rule-based,
// not AI: it answers the handful of questions customers keep asking and stays
// silent on everything else, so it can never invent a price or a trial term.
// Edit AUTO_REPLY_RULES below to change what it says.
// ---------------------------------------------------------------------------

const BUSINESS_GREETING =
  "سلام! 👋 ممنون که پیام دادید.\n" +
  "این یک پاسخ خودکار است؛ خودم هم به‌زودی جواب می‌دهم.\n\n" +
  "MultiSender یک پست را هم‌زمان به تلگرام، بله، روبیکا و ایتا می‌فرستد:\n" +
  SITE_URL +
  "\n\nبرای کد آزمایشی رایگان کافی است بنویسید «کد».";

// First matching rule wins, so the more specific ones come first.
const AUTO_REPLY_RULES = [
  {
    keywords: ["مشکل", "خطا", "ارور", "کار نمیکنه", "کار نمی کنه", "ارسال نشد", "نمیره", "نمی ره"],
    reply:
      "متوجه شدم مشکلی پیش آمده 🙏\n" +
      "لطفاً بنویسید دقیقاً در کدام مرحله بوده و اگر می‌شود یک اسکرین‌شات بفرستید.\n" +
      "خودم بررسی می‌کنم و همین‌جا جواب می‌دهم.",
  },
  {
    keywords: ["کد", "کد ازمایشی", "کد تست", "رایگان", "ازمایشی", "promo", "code"],
    reply:
      "برای گرفتن کد آزمایشی رایگان همین‌جا بنویسید «کد می‌خواهم» — کد را می‌سازم و برایتان می‌فرستم.\n\n" +
      "کد را در فرم ثبت پست وارد می‌کنید:\n" +
      SITE_URL +
      "\n\nشمارش روزهای آزمایشی از اولین ارسال شما شروع می‌شود، نه از لحظه‌ای که کد ساخته می‌شود.",
  },
  {
    keywords: ["قیمت", "هزینه", "تعرفه", "اشتراک", "پرداخت", "تمدید"],
    reply:
      "دورهٔ آزمایشی رایگان است و از اولین ارسال شما شروع می‌شود.\n" +
      "برای ادامهٔ کار بعد از دورهٔ آزمایشی همین‌جا بنویسید تا شرایط را برایتان بفرستم.",
  },
  {
    keywords: ["راهنما", "چطور", "چگونه", "اموزش", "شروع", "start", "ثبت پست", "ارسال پست"],
    reply:
      "راهنمای قدم‌به‌قدم:\n" +
      "۱) کد آزمایشی بگیرید (بنویسید «کد»).\n" +
      "۲) به این صفحه بروید: " +
      SITE_URL +
      "\n۳) متن و عکس یا ویدیوی پست را بگذارید.\n" +
      "۴) آیدی کانال‌های مقصد را وارد کنید.\n" +
      "۵) ثبت کنید — پست حداکثر تا ۱۰ دقیقه در همهٔ کانال‌ها منتشر می‌شود.",
  },
  {
    keywords: ["پلتفرم", "پیام رسان", "روبیکا", "ایتا", "تلگرام", "کانال", "شبکه"],
    reply:
      "پست شما هم‌زمان به چهار پیام‌رسان می‌رود: تلگرام، بله، روبیکا و ایتا.\n" +
      "فقط باید ربات را در هر کانال مقصد ادمین کنید تا بتواند پست بگذارد.",
  },
  {
    keywords: ["سلام", "درود", "وقت بخیر", "hi", "hello"],
    reply: BUSINESS_GREETING,
  },
];

// Persian text arrives in several equivalent spellings (Arabic ي/ك, ZWNJ,
// آ/أ), so both sides of a comparison get flattened to one of them first.
// Punctuation and emoji become spaces, which is also what makes whole-word
// matching below possible.
function normalizeFa(text) {
  return text
    .toLowerCase()
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[آأإ]/g, "ا")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function matchAutoReply(text) {
  const haystack = normalizeFa(text || "");
  if (!haystack) return null;
  const words = haystack.split(" ");

  for (const rule of AUTO_REPLY_RULES) {
    const hit = rule.keywords.some((raw) => {
      const keyword = normalizeFa(raw);
      // A short keyword like "کد" would fire inside unrelated words ("کدام"),
      // so it has to match a whole word. Longer ones match as substrings, which
      // is what lets attached suffixes ("قیمتش", "مشکلم") still hit.
      return keyword.length >= 4 || keyword.includes(" ")
        ? haystack.includes(keyword)
        : words.includes(keyword);
    });
    if (hit) return rule.reply;
  }
  return null;
}

async function storeBusinessConnection(connection, env) {
  const key = `bizconn:${connection.id}`;
  if (!connection.is_enabled) {
    await env.MULTI_SENDER_KV.delete(key);
    return;
  }
  // can_reply moved into a rights object in newer Bot API versions.
  const canReply = connection.rights
    ? Boolean(connection.rights.can_reply)
    : Boolean(connection.can_reply);
  await env.MULTI_SENDER_KV.put(
    key,
    JSON.stringify({ owner_id: connection.user && connection.user.id, can_reply: canReply }),
  );
}

async function handleBusinessMessage(msg, env) {
  if (!env.SUPPORT_BOT_TOKEN) return;

  const raw = await env.MULTI_SENDER_KV.get(`bizconn:${msg.business_connection_id}`);
  const connection = raw ? JSON.parse(raw) : null;
  if (!connection || !connection.can_reply) return;

  // business_message also carries the messages *you* send - never answer those.
  if (msg.from && msg.from.id === connection.owner_id) return;
  if (!msg.chat || msg.chat.type !== "private") return;

  const reply = matchAutoReply(msg.text || msg.caption || "");
  const seenKey = `bizauto:${msg.chat.id}`;

  if (!reply) {
    // Nothing matched. Greet a first-time contact so they aren't left staring
    // at silence, then stay out of the way: you answer the rest yourself, and
    // a bot talking over you is worse than a bot saying nothing.
    if (await env.MULTI_SENDER_KV.get(seenKey)) return;
    await sendBusinessReply(env, msg, BUSINESS_GREETING);
  } else {
    await sendBusinessReply(env, msg, reply);
  }
  await env.MULTI_SENDER_KV.put(seenKey, "1", { expirationTtl: 60 * 60 * 24 * 30 });
}

function sendBusinessReply(env, msg, text) {
  return telegramApi(env.SUPPORT_BOT_TOKEN, "sendMessage", {
    business_connection_id: msg.business_connection_id,
    chat_id: msg.chat.id,
    text,
    link_preview_options: { is_disabled: true },
  });
}

async function handleTelegramWebhook(request, env) {
  if (
    !env.TELEGRAM_WEBHOOK_SECRET ||
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return new Response("Not found", { status: 404 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true }); // ignore malformed bodies rather than error-loop Telegram's retries
  }

  if (update.business_connection) {
    await storeBusinessConnection(update.business_connection, env);
  } else if (update.business_message) {
    await handleBusinessMessage(update.business_message, env);
  }

  return json({ ok: true });
}

async function handleRegisterTelegramWebhook(request, env) {
  if (!env.SUPPORT_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "SUPPORT_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must both be set as Worker secrets first" }, 400);
  }
  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/webhook/telegram`;
  const result = await telegramApi(env.SUPPORT_BOT_TOKEN, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    // business_* updates are never delivered unless they are asked for by name.
    allowed_updates: ["business_connection", "business_message"],
  });
  return json({ ok: true, webhookUrl, telegramResponse: result });
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

    if (request.method === "POST" && url.pathname === "/admin/register-telegram-webhook") {
      if (!requireBearer(request, env.ADMIN_TOKEN)) return unauthorized();
      return handleRegisterTelegramWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/webhook/telegram") {
      return handleTelegramWebhook(request, env);
    }

    const rubikaWebhookMatch = url.pathname.match(/^\/webhook\/rubika\/([^/]+)$/);
    if (request.method === "POST" && rubikaWebhookMatch) {
      return handleRubikaWebhook(request, env, rubikaWebhookMatch[1]);
    }

    return json({ error: "not_found" }, 404);
  },
};
