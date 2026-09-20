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
 * Growth (self-serve, no human in the loop):
 *   POST /trial               {contact, ref?, v?} -> issues a limited trial code
 *                              on the spot (TRIAL_DAYS days / TRIAL_MAX_POSTS
 *                              posts). One per contact, rate-limited per IP.
 *   GET  /r/:ref?v=<variant>   the tracked link appended to every delivered post:
 *                              counts the click (per copy variant) and 302s to
 *                              the site with ?ref=&v= so a signup can credit the
 *                              referrer. Link-preview bots are not counted.
 *
 * Monetization (pay-per-pack credits; see PLANS):
 *   GET  /plans               packs + whether each is buyable online yet
 *   POST /checkout            {plan_id, contact?} -> {pay_url} (Zarinpal)
 *   GET  /pay/callback        Zarinpal's return URL: verifies, issues the pack
 *                              code, redirects to pay-result.html
 *   GET  /order/:id           poll an order (id is unguessable) -> code once paid
 *
 * Private (Authorization: Bearer <API_TOKEN> - the bot's GitHub Actions run):
 *   GET    /pending            list ids of not-yet-fully-delivered submissions
 *   GET    /submission/:id     full submission record
 *   DELETE /submission/:id     called once delivery to every sender succeeds
 *
 * Admin (Authorization: Bearer <ADMIN_TOKEN> - only you):
 *   POST /promo                             create/update a promo code's trial window
 *                                            ({code, trial_days, max_posts?})
 *   POST /admin/issue-pack                  {plan_id, contact?} -> mints a pack code
 *                                            (for sales you close through support)
 *   GET  /admin/stats                       attribution-copy funnel + top referrers
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
 *   promo:<code>      -> { kind: "trial"|"pack"|undefined(admin), trial_days, first_used_at,
 *                          max_posts (null = unlimited), posts_used, ref_code, referred_by,
 *                          referral_credited, referral_rewards, contact, signup_variant }
 *   ref:<ref_code>    -> promo code that owns this public referral id
 *   refstat:<ref>     -> { signups, activations } credited to that referrer
 *   stats:funnel      -> { <variant>: { clicks, signups, activations } }
 *   trialcontact:<h>  -> promo code (dedupes trials per hashed contact)
 *   trialip:<h>       -> trials issued from this hashed IP (24h TTL)
 *   order:<id>        -> { plan_id, status, authority, code, contact }
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

// Tunable without a redeploy of code: set any of these as plain [vars].
const DEFAULTS = {
  TRIAL_DAYS: 3,
  TRIAL_MAX_POSTS: 5,
  TRIAL_MAX_PER_IP_PER_DAY: 5, // generous on purpose: mobile carriers put many people behind one IP
  REFERRAL_BONUS_DAYS: 2,
  REFERRAL_BONUS_POSTS: 2,
  REFERRAL_MAX_REWARDS: 10,
  // Every counted click is a KV write and the free tier caps writes per day, so
  // a link that spreads could starve real submissions. Below 1, only that
  // fraction of clicks is recorded, each weighted 1/rate, so funnel totals stay
  // unbiased while the write load drops.
  CLICK_SAMPLE_RATE: 1,
};

function cfg(env, name) {
  const raw = env[name];
  const value = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) ? value : DEFAULTS[name];
}

// Pay-per-pack credits. A pack with no price stays "contact support"; it only
// becomes buyable online once it has a price AND ZARINPAL_MERCHANT_ID is set.
// Prices live in the PLAN_PRICES_TOMAN var (JSON, e.g. {"pack50": 99000}) so
// publishing one is a config change, not a code change. valid_days counts from
// the pack's first use, like a trial.
const PLANS = [
  { id: "pack50", title: "بستهٔ ۵۰ پستی", posts: 50, valid_days: 365 },
  { id: "pack200", title: "بستهٔ ۲۰۰ پستی", posts: 200, valid_days: 365 },
];

function planPrice(plan, env) {
  try {
    const price = Number(JSON.parse(env.PLAN_PRICES_TOMAN || "{}")[plan.id]);
    return Number.isFinite(price) && price > 0 ? Math.round(price) : null;
  } catch {
    return null; // a malformed var must degrade to "contact support", not to a 500
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I: codes get read aloud and retyped
const REF_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const HEX_ALPHABET = "0123456789abcdef";

function randomString(length, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function kvGetJson(env, key) {
  const raw = await env.MULTI_SENDER_KV.get(key);
  return raw ? JSON.parse(raw) : null;
}

function kvPutJson(env, key, value, options) {
  return env.MULTI_SENDER_KV.put(key, JSON.stringify(value), options);
}

function postsLeft(promo) {
  // max_posts null/undefined = unlimited (admin-issued codes, legacy codes).
  return Number.isFinite(promo.max_posts) ? Math.max(0, promo.max_posts - (promo.posts_used || 0)) : null;
}

function daysLeftOf(promo, now) {
  if (!promo.first_used_at) return promo.trial_days;
  const elapsedDays = (now - Date.parse(promo.first_used_at)) / 86400000;
  return Math.max(0, Math.ceil(promo.trial_days - elapsedDays));
}

function trialStatus(promo, now) {
  if (!promo) return { valid: false, reason: "not_found" };
  const days_left = daysLeftOf(promo, now);
  const posts_left = postsLeft(promo);
  if (days_left <= 0) return { valid: false, reason: "expired" };
  if (posts_left === 0) return { valid: false, reason: "exhausted" };
  return { valid: true, days_left, started: Boolean(promo.first_used_at), posts_left };
}

// A public id for share links, separate from the promo code itself: the code
// lets anyone post as that customer, so it must never appear in a URL.
async function assignRefCode(env, promoCode, promo) {
  if (promo.ref_code) return promo.ref_code;
  promo.ref_code = randomString(8, REF_ALPHABET);
  await env.MULTI_SENDER_KV.put(`ref:${promo.ref_code}`, promoCode);
  return promo.ref_code;
}

function cleanRef(value) {
  const ref = String(value || "");
  return /^[a-z0-9]{6,12}$/.test(ref) ? ref : null;
}

function cleanVariant(value) {
  const variant = String(value || "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(variant) ? variant : null;
}

// Stats are best-effort by design: KV's free tier caps writes per day, and a
// counter that fails must never take down a redirect or a submission.
async function bumpFunnel(env, variant, field, amount = 1) {
  try {
    const stats = (await kvGetJson(env, "stats:funnel")) || {};
    const key = variant || "none";
    stats[key] = stats[key] || { clicks: 0, signups: 0, activations: 0 };
    stats[key][field] += amount;
    await kvPutJson(env, "stats:funnel", stats);
  } catch {
    /* ignore */
  }
}

async function bumpReferrer(env, ref, field) {
  try {
    const key = `refstat:${ref}`;
    const stats = (await kvGetJson(env, key)) || { signups: 0, activations: 0 };
    stats[field] += 1;
    await kvPutJson(env, key, stats);
  } catch {
    /* ignore */
  }
}

// Runs once per code, on its first real submission. A referral only pays out
// here (not at signup) so minting throwaway trials doesn't earn anything.
// Mutates `promo`; the caller persists it.
async function recordActivation(env, promoCode, promo) {
  if (promo.signup_variant) await bumpFunnel(env, promo.signup_variant, "activations");
  if (!promo.referred_by || promo.referral_credited) return;
  promo.referral_credited = true;

  const referrerCode = await env.MULTI_SENDER_KV.get(`ref:${promo.referred_by}`);
  if (!referrerCode || referrerCode === promoCode) return;
  const referrer = await kvGetJson(env, `promo:${referrerCode}`);
  if (!referrer || (referrer.referral_rewards || 0) >= cfg(env, "REFERRAL_MAX_REWARDS")) return;

  referrer.trial_days += cfg(env, "REFERRAL_BONUS_DAYS");
  if (Number.isFinite(referrer.max_posts)) referrer.max_posts += cfg(env, "REFERRAL_BONUS_POSTS");
  referrer.referral_rewards = (referrer.referral_rewards || 0) + 1;
  await kvPutJson(env, `promo:${referrerCode}`, referrer);
  await bumpReferrer(env, promo.referred_by, "activations");
}

function rejectionFor(status) {
  if (status.reason === "expired") return "دورهٔ آزمایشی شما به پایان رسیده است.";
  if (status.reason === "exhausted") return "اعتبار پست‌های این کد تمام شده است.";
  return "کد تبلیغی نامعتبر است.";
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

  const promo = await kvGetJson(env, `promo:${promoCode}`);
  const now = Date.now();
  const status = trialStatus(promo, now);
  if (!status.valid) {
    return json({ error: rejectionFor(status), reason: status.reason }, 403, corsHeaders(origin));
  }

  // Everything that can reject the request runs before anything is charged
  // against the code, so a too-big upload doesn't cost a post or start a trial.
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

  if (!status.started) {
    promo.first_used_at = new Date(now).toISOString();
    await recordActivation(env, promoCode, promo);
  }
  promo.posts_used = (promo.posts_used || 0) + 1;
  const refCode = await assignRefCode(env, promoCode, promo);
  await kvPutJson(env, `promo:${promoCode}`, promo);

  const id = `sub_${now}_${Math.random().toString(36).slice(2, 10)}`;
  const submission = {
    caption,
    add_extras: addExtras,
    media_base64: mediaBase64,
    media_type: mediaType,
    media_content_type: mediaContentType,
    destinations,
    promo_code: promoCode,
    ref_code: refCode, // lets the bot build this customer's tracked attribution link
    created_at: new Date(now).toISOString(),
  };
  await kvPutJson(env, `submission:${id}`, submission);

  return json(
    {
      ok: true,
      id,
      days_left: daysLeftOf(promo, now),
      posts_left: postsLeft(promo),
      ref_code: refCode,
      message: "پست شما ثبت شد و طی چند دقیقه آینده ارسال می‌شود.",
    },
    200,
    corsHeaders(origin)
  );
}

async function handlePromoStatus(code, env, origin) {
  const promo = await kvGetJson(env, `promo:${code}`);
  const body = trialStatus(promo, Date.now());
  if (promo) {
    body.kind = promo.kind || "admin";
    body.ref_code = promo.ref_code || null;
  }
  return json(body, 200, corsHeaders(origin));
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
  const maxPosts = body.max_posts === undefined || body.max_posts === null || body.max_posts === "" ? null : Number(body.max_posts);
  if (!code) return json({ error: "code is required" }, 400);
  if (maxPosts !== null && !Number.isFinite(maxPosts)) return json({ error: "max_posts must be a number" }, 400);

  // Re-issuing an existing code restarts its window and post count but keeps
  // its public referral id and reward history.
  const existing = await kvGetJson(env, `promo:${code}`);
  const promo = { ...(existing || {}), trial_days: trialDays, max_posts: maxPosts, posts_used: 0, first_used_at: null };
  await kvPutJson(env, `promo:${code}`, promo);
  return json({ ok: true, code, trial_days: trialDays, max_posts: maxPosts });
}

// ---------------------------------------------------------------------------
// Growth: self-serve trial + tracked referral link
// ---------------------------------------------------------------------------

function toAsciiDigits(text) {
  return text.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}

// Accepts a Telegram @handle / t.me link, or an Iranian mobile number in any of
// its usual spellings. Anything else is rejected so the field can't be junk.
function normalizeContact(raw) {
  const text = toAsciiDigits(String(raw || "").trim());
  if (!text) return null;

  const digits = text.replace(/[\s\-()+]/g, "");
  if (/^\d+$/.test(digits)) {
    let number = digits.replace(/^0098/, "98");
    if (number.startsWith("09")) number = "98" + number.slice(1);
    else if (/^9\d{9}$/.test(number)) number = "98" + number;
    return /^989\d{9}$/.test(number) ? { type: "phone", value: number, display: "+" + number } : null;
  }

  const handle = text
    .replace(/^https?:\/\/(www\.)?t\.me\//i, "")
    .replace(/^t\.me\//i, "")
    .replace(/^@/, "")
    .split(/[/?]/)[0]
    .toLowerCase();
  return /^[a-z][a-z0-9_]{4,31}$/.test(handle) ? { type: "telegram", value: handle, display: "@" + handle } : null;
}

async function handleTrial(request, env, origin) {
  const cors = corsHeaders(origin);
  const body = (await request.json().catch(() => null)) || {};

  const contact = normalizeContact(body.contact);
  if (!contact) {
    return json({ error: "شناسهٔ تلگرام (مثل @name) یا شمارهٔ موبایل معتبر وارد کنید.", reason: "bad_contact" }, 400, cors);
  }

  const ipKey = `trialip:${await sha256Hex(request.headers.get("CF-Connecting-IP") || "unknown")}`;
  const ipCount = Number(await env.MULTI_SENDER_KV.get(ipKey)) || 0;
  if (ipCount >= cfg(env, "TRIAL_MAX_PER_IP_PER_DAY")) {
    return json(
      { error: "امروز از این شبکه درخواست‌های زیادی رسیده؛ فردا دوباره امتحان کنید یا از پشتیبانی کد بگیرید.", reason: "rate_limited" },
      429,
      cors
    );
  }

  const contactKey = `trialcontact:${await sha256Hex(`${contact.type}:${contact.value}`)}`;
  if (await env.MULTI_SENDER_KV.get(contactKey)) {
    // The handle isn't verified, so returning the existing code would hand it
    // to whoever typed someone else's name. Point at support instead.
    return json(
      { error: "برای این شناسه قبلاً کد آزمایشی صادر شده است. اگر کدتان را گم کرده‌اید یا اعتبارش تمام شده، از پشتیبانی بپرسید یا بستهٔ پستی بگیرید.", reason: "already_claimed" },
      409,
      cors
    );
  }

  let code;
  do {
    code = "TRY-" + randomString(6, CODE_ALPHABET);
  } while (await env.MULTI_SENDER_KV.get(`promo:${code}`));

  // A referral only counts if the ref id really exists; unknown ones are ignored.
  const refParam = cleanRef(body.ref);
  const referredBy = refParam && (await env.MULTI_SENDER_KV.get(`ref:${refParam}`)) ? refParam : null;
  const variant = cleanVariant(body.v);

  const promo = {
    kind: "trial",
    trial_days: cfg(env, "TRIAL_DAYS"),
    max_posts: cfg(env, "TRIAL_MAX_POSTS"),
    posts_used: 0,
    first_used_at: null,
    contact: contact.display,
    created_at: new Date().toISOString(),
    referred_by: referredBy,
    signup_variant: variant,
  };
  await assignRefCode(env, code, promo);
  await Promise.all([
    kvPutJson(env, `promo:${code}`, promo),
    env.MULTI_SENDER_KV.put(contactKey, code),
    env.MULTI_SENDER_KV.put(ipKey, String(ipCount + 1), { expirationTtl: 86400 }),
  ]);

  await bumpFunnel(env, variant, "signups");
  if (referredBy) await bumpReferrer(env, referredBy, "signups");

  return json(
    { ok: true, code, trial_days: promo.trial_days, max_posts: promo.max_posts, ref_code: promo.ref_code },
    200,
    cors
  );
}

// Link-preview fetchers (Telegram, Twitter, ...) request this URL the moment a
// post is sent; counting them would make every post look like a click.
const BOT_USER_AGENT = /bot|crawl|spider|preview|facebookexternalhit|slurp/i;

async function handleReferralRedirect(ref, url, request, env, ctx) {
  const variant = cleanVariant(url.searchParams.get("v"));
  const knownRef = cleanRef(ref) && (await env.MULTI_SENDER_KV.get(`ref:${ref}`)) ? ref : null;

  const target = new URL(SITE_URL);
  if (knownRef) target.searchParams.set("ref", knownRef);
  if (variant) target.searchParams.set("v", variant);

  const rate = Math.min(1, Math.max(0, cfg(env, "CLICK_SAMPLE_RATE")));
  if (rate > 0 && !BOT_USER_AGENT.test(request.headers.get("User-Agent") || "") && Math.random() < rate) {
    const counted = bumpFunnel(env, variant, "clicks", Math.round(1 / rate));
    if (ctx && ctx.waitUntil) ctx.waitUntil(counted);
    else await counted;
  }
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Monetization: pay-per-pack credits, paid through Zarinpal
// ---------------------------------------------------------------------------

function paymentsEnabled(env) {
  return Boolean(env.ZARINPAL_MERCHANT_ID);
}

// Base URL is overridable because gateways move endpoints; the sandbox flag is
// how you test the whole flow with fake money before going live.
function zarinpalBase(env) {
  if (env.ZARINPAL_BASE) return env.ZARINPAL_BASE.replace(/\/$/, "");
  return env.ZARINPAL_SANDBOX === "true" ? "https://sandbox.zarinpal.com" : "https://payment.zarinpal.com";
}

function publicPlan(plan, env) {
  const price = planPrice(plan, env);
  return {
    id: plan.id,
    title: plan.title,
    posts: plan.posts,
    valid_days: plan.valid_days,
    price_toman: price,
    purchasable: price !== null && paymentsEnabled(env),
  };
}

// Also serves the trial/referral numbers so pages can show the live values
// instead of hard-coding ones that TRIAL_* / REFERRAL_* vars can change.
function handlePlans(env, origin) {
  return json(
    {
      plans: PLANS.map((plan) => publicPlan(plan, env)),
      payments_enabled: paymentsEnabled(env),
      support_url: SUPPORT_URL,
      trial: { days: cfg(env, "TRIAL_DAYS"), max_posts: cfg(env, "TRIAL_MAX_POSTS") },
      referral: {
        bonus_days: cfg(env, "REFERRAL_BONUS_DAYS"),
        bonus_posts: cfg(env, "REFERRAL_BONUS_POSTS"),
        max_rewards: cfg(env, "REFERRAL_MAX_REWARDS"),
      },
    },
    200,
    corsHeaders(origin)
  );
}

async function createPackPromo(env, plan, extra) {
  let code;
  do {
    code = "PK-" + randomString(8, CODE_ALPHABET);
  } while (await env.MULTI_SENDER_KV.get(`promo:${code}`));

  const promo = {
    kind: "pack",
    plan_id: plan.id,
    trial_days: plan.valid_days,
    max_posts: plan.posts,
    posts_used: 0,
    first_used_at: null,
    created_at: new Date().toISOString(),
    ...extra,
  };
  await assignRefCode(env, code, promo);
  await kvPutJson(env, `promo:${code}`, promo);
  return code;
}

async function handleCheckout(request, env, origin) {
  const cors = corsHeaders(origin);
  const body = (await request.json().catch(() => null)) || {};
  const plan = PLANS.find((p) => p.id === body.plan_id);
  if (!plan) return json({ error: "بستهٔ نامعتبر است." }, 400, cors);

  if (!publicPlan(plan, env).purchasable) {
    return json(
      { error: "پرداخت آنلاین برای این بسته هنوز فعال نیست؛ لطفاً با پشتیبانی هماهنگ کنید.", support_url: SUPPORT_URL },
      503,
      cors
    );
  }

  const orderId = randomString(24, HEX_ALPHABET);
  const amountToman = planPrice(plan, env);
  const callbackUrl = `${new URL(request.url).origin}/pay/callback?order=${orderId}`;
  const response = await fetch(`${zarinpalBase(env)}/pg/v4/payment/request.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      merchant_id: env.ZARINPAL_MERCHANT_ID,
      amount: amountToman * 10, // the gateway counts in rials, prices here are in toman
      callback_url: callbackUrl,
      description: `MultiSender - ${plan.title}`,
    }),
  });
  const result = await response.json().catch(() => null);
  const authority = result && result.data && result.data.authority;
  if (!authority) {
    return json({ error: "ارتباط با درگاه پرداخت برقرار نشد؛ دوباره تلاش کنید یا با پشتیبانی تماس بگیرید." }, 502, cors);
  }

  const order = {
    plan_id: plan.id,
    amount_toman: amountToman, // verified against this, not against whatever the price is by the time they return
    status: "pending",
    authority,
    contact: String(body.contact || "").trim().slice(0, 100) || null,
    created_at: new Date().toISOString(),
  };
  await kvPutJson(env, `order:${orderId}`, order, { expirationTtl: 172800 });
  return json({ ok: true, order_id: orderId, pay_url: `${zarinpalBase(env)}/pg/StartPay/${authority}` }, 200, cors);
}

function redirectTo(location) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

async function handlePayCallback(url, env) {
  const orderId = url.searchParams.get("order") || "";
  const resultPage = `${SITE_URL}pay-result.html`;
  const back = () => redirectTo(`${resultPage}?order=${encodeURIComponent(orderId)}`);

  const order = /^[a-f0-9]{24}$/.test(orderId) ? await kvGetJson(env, `order:${orderId}`) : null;
  if (!order) return redirectTo(resultPage);
  if (order.status === "paid") return back(); // a reloaded callback must not mint a second code

  const fail = async () => {
    order.status = "failed";
    await kvPutJson(env, `order:${orderId}`, order, { expirationTtl: 172800 });
    return back();
  };

  const authority = url.searchParams.get("Authority");
  if (url.searchParams.get("Status") !== "OK" || !authority || authority !== order.authority) return fail();

  const plan = PLANS.find((p) => p.id === order.plan_id);
  if (!plan) return fail();

  // Never trust the redirect alone: the browser is the one carrying "OK" here.
  const response = await fetch(`${zarinpalBase(env)}/pg/v4/payment/verify.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ merchant_id: env.ZARINPAL_MERCHANT_ID, amount: order.amount_toman * 10, authority }),
  });
  const result = await response.json().catch(() => null);
  const verifiedCode = result && result.data && result.data.code;
  if (verifiedCode !== 100 && verifiedCode !== 101) return fail(); // 101 = already verified

  order.code = await createPackPromo(env, plan, { contact: order.contact, order_id: orderId });
  order.status = "paid";
  order.gateway_ref = result.data.ref_id || null;
  await kvPutJson(env, `order:${orderId}`, order);
  return back();
}

async function handleOrder(orderId, env, origin) {
  const order = /^[a-f0-9]{24}$/.test(orderId) ? await kvGetJson(env, `order:${orderId}`) : null;
  if (!order) return json({ status: "not_found" }, 404, corsHeaders(origin));
  const plan = PLANS.find((p) => p.id === order.plan_id);
  const body = { status: order.status, plan_title: plan ? plan.title : null };
  if (order.status === "paid") {
    body.code = order.code;
    body.posts = plan ? plan.posts : null;
    body.valid_days = plan ? plan.valid_days : null;
  }
  return json(body, 200, corsHeaders(origin));
}

async function handleIssuePack(request, env) {
  const body = (await request.json().catch(() => null)) || {};
  const plan = PLANS.find((p) => p.id === body.plan_id);
  if (!plan) return json({ error: "unknown plan_id", plans: PLANS.map((p) => p.id) }, 400);
  const code = await createPackPromo(env, plan, { contact: body.contact ? String(body.contact).slice(0, 100) : null, issued_by: "admin" });
  return json({ ok: true, code, plan_id: plan.id, posts: plan.posts, valid_days: plan.valid_days });
}

// Which attribution copy earns signups, and who is actually referring people.
async function handleStats(env) {
  const funnel = (await kvGetJson(env, "stats:funnel")) || {};
  const percent = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
  const variants = Object.fromEntries(
    Object.entries(funnel).map(([variant, s]) => [
      variant,
      { ...s, click_to_signup_pct: percent(s.signups, s.clicks), signup_to_activation_pct: percent(s.activations, s.signups) },
    ])
  );

  const listed = await env.MULTI_SENDER_KV.list({ prefix: "refstat:", limit: 100 });
  const referrers = await Promise.all(
    listed.keys.map(async (key) => {
      const ref = key.name.slice("refstat:".length);
      const stats = await kvGetJson(env, key.name);
      const ownerCode = await env.MULTI_SENDER_KV.get(`ref:${ref}`);
      const owner = ownerCode ? await kvGetJson(env, `promo:${ownerCode}`) : null;
      return { ref, contact: owner ? owner.contact || null : null, ...stats };
    })
  );
  referrers.sort((a, b) => (b.activations || 0) - (a.activations || 0));

  return json({ variants, top_referrers: referrers.slice(0, 20) });
}

const SITE_URL = "https://aliaslany.github.io/Multi_sender/";
const SUPPORT_URL = "https://t.me/Divarassist";
const GREETING_TEXT =
  "سلام! 👋 این‌جا ربات ارسال‌کنندهٔ MultiSender است.\n\n" +
  "برای امتحان رایگان و ارسال خودکار یک پست به تلگرام، بله، روبیکا و ایتا، وارد لینک زیر شوید؛ کد آزمایشی را همان‌جا خودکار می‌گیرید:\n" +
  SITE_URL +
  "\n\nسؤال دارید؟ از پشتیبانی بپرسید: " +
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
  "\n\nکد آزمایشی رایگان خودکار است؛ فقط وارد لینک بالا شوید.";

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
      "کد آزمایشی رایگان خودکار صادر می‌شود: وارد این صفحه شوید و در مرحلهٔ «کد آزمایشی» شناسهٔ تلگرام یا شمارهٔ موبایلتان را بزنید؛ کد همان‌جا آماده است:\n" +
      SITE_URL +
      "\n\nشمارش روزهای آزمایشی از اولین ارسال شما شروع می‌شود، نه از لحظه‌ای که کد ساخته می‌شود.",
  },
  {
    keywords: ["قیمت", "هزینه", "تعرفه", "اشتراک", "پرداخت", "تمدید"],
    reply:
      "دورهٔ آزمایشی رایگان است و از اولین ارسال شما شروع می‌شود.\n" +
      "بعد از آن اعتبار به‌صورت «بستهٔ پستی» خریداری می‌شود (اشتراک ماهانه نیست؛ اعتبار هر بسته یک سال از اولین استفاده است). جزئیات:\n" +
      SITE_URL +
      "pricing.html\n\nبرای خرید همین‌جا بنویسید تا هماهنگ کنم.",
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      return handleSubmit(request, env, origin);
    }

    if (request.method === "POST" && url.pathname === "/trial") {
      return handleTrial(request, env, origin);
    }

    const referralMatch = url.pathname.match(/^\/r\/([^/]+)$/);
    if (request.method === "GET" && referralMatch) {
      return handleReferralRedirect(referralMatch[1], url, request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/plans") {
      return handlePlans(env, origin);
    }
    if (request.method === "POST" && url.pathname === "/checkout") {
      return handleCheckout(request, env, origin);
    }
    if (request.method === "GET" && url.pathname === "/pay/callback") {
      return handlePayCallback(url, env);
    }
    const orderMatch = url.pathname.match(/^\/order\/([^/]+)$/);
    if (request.method === "GET" && orderMatch) {
      return handleOrder(orderMatch[1], env, origin);
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
    if (request.method === "POST" && url.pathname === "/admin/issue-pack") {
      if (!requireBearer(request, env.ADMIN_TOKEN)) return unauthorized();
      return handleIssuePack(request, env);
    }
    if (request.method === "GET" && url.pathname === "/admin/stats") {
      if (!requireBearer(request, env.ADMIN_TOKEN)) return unauthorized();
      return handleStats(env);
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
