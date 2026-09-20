// Run with:  cd worker && node --test     (Node 20+, no dependencies)
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import worker from "../src/index.js";

class MemoryKV {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  async put(key, value, options = {}) {
    const expiresAt = options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
    this.store.set(key, { value: String(value), expiresAt });
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
    return { keys: keys.map((name) => ({ name })) };
  }
}

const ADMIN = { Authorization: "Bearer admin-secret" };
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

let env;
let ipCounter;

beforeEach(() => {
  ipCounter = 0;
  env = { MULTI_SENDER_KV: new MemoryKV(), ADMIN_TOKEN: "admin-secret", API_TOKEN: "api-secret", ALLOWED_ORIGIN: "https://site.test" };
});

async function call(path, { method = "GET", headers = {}, json, form, ip } = {}) {
  const init = { method, headers: { "User-Agent": BROWSER_UA, ...headers } };
  // A fresh IP per call unless the test pins one, so unrelated tests don't trip the rate limit.
  init.headers["CF-Connecting-IP"] = ip || `10.0.0.${++ipCounter}`;
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  }
  if (form) init.body = form;
  return worker.fetch(new Request(`https://worker.test${path}`, init), env, undefined);
}

function submitForm(code, extra = {}) {
  const form = new FormData();
  form.set("promo_code", code);
  form.set("caption", "hello");
  form.set("telegram_chat_id", "@dest");
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

const trial = (contact, extra = {}, opts = {}) => call("/trial", { method: "POST", json: { contact, ...extra }, ...opts });

describe("promo status", () => {
  test("unknown code", async () => {
    const res = await call("/promo/NOPE/status");
    assert.deepEqual(await res.json(), { valid: false, reason: "not_found" });
  });

  test("admin-issued legacy code is unlimited and starts on first use", async () => {
    const created = await call("/promo", { method: "POST", headers: ADMIN, json: { code: "SUMMER7", trial_days: 7 } });
    assert.equal(created.status, 200);
    const status = await (await call("/promo/SUMMER7/status")).json();
    assert.equal(status.valid, true);
    assert.equal(status.started, false);
    assert.equal(status.days_left, 7);
    assert.equal(status.posts_left, null);
  });

  test("creating a promo requires the admin token", async () => {
    const res = await call("/promo", { method: "POST", json: { code: "X", trial_days: 1 } });
    assert.equal(res.status, 401);
  });
});

describe("self-serve trial", () => {
  test("rejects junk contacts", async () => {
    for (const contact of ["", "ab", "hello world!", "12345", "@a"]) {
      const res = await trial(contact);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(contact)}`);
    }
  });

  test("issues a limited code that is immediately usable", async () => {
    const res = await trial("@Some_User");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.code, /^TRY-[A-Z2-9]{6}$/);
    assert.equal(body.trial_days, 3);
    assert.equal(body.max_posts, 5);

    const status = await (await call(`/promo/${body.code}/status`)).json();
    assert.equal(status.valid, true);
    assert.equal(status.posts_left, 5);
    assert.equal(status.ref_code, body.ref_code);
  });

  test("one trial per contact, however it is spelled", async () => {
    assert.equal((await trial("@some_user")).status, 200);
    assert.equal((await trial("https://t.me/Some_User")).status, 409);
    assert.equal((await trial("some_user")).status, 409);
  });

  test("phone numbers normalise across spellings (incl. Persian digits)", async () => {
    assert.equal((await trial("09121234567")).status, 200);
    assert.equal((await trial("+98 912 123 4567")).status, 409);
    assert.equal((await trial("۰۹۱۲۱۲۳۴۵۶۷")).status, 409);
  });

  test("a repeat request never leaks the existing code", async () => {
    const first = await (await trial("@some_user")).json();
    const repeat = await trial("@some_user");
    assert.equal(repeat.status, 409);
    assert.ok(!JSON.stringify(await repeat.json()).includes(first.code));
  });

  test("per-IP daily limit", async () => {
    env.TRIAL_MAX_PER_IP_PER_DAY = "2";
    assert.equal((await trial("@user_one", {}, { ip: "1.1.1.1" })).status, 200);
    assert.equal((await trial("@user_two", {}, { ip: "1.1.1.1" })).status, 200);
    assert.equal((await trial("@user_three", {}, { ip: "1.1.1.1" })).status, 429);
    assert.equal((await trial("@user_three", {}, { ip: "2.2.2.2" })).status, 200);
  });
});

describe("submitting against limited codes", () => {
  test("posts are counted and the code exhausts", async () => {
    env.TRIAL_MAX_POSTS = "2";
    const { code } = await (await trial("@some_user")).json();

    const first = await call("/submit", { method: "POST", form: submitForm(code) });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).posts_left, 1);

    const second = await call("/submit", { method: "POST", form: submitForm(code) });
    const secondBody = await second.json();
    assert.equal(secondBody.posts_left, 0);
    assert.equal(typeof secondBody.days_left, "number", "days_left must survive the last post");

    const third = await call("/submit", { method: "POST", form: submitForm(code) });
    assert.equal(third.status, 403);
    assert.equal((await third.json()).reason, "exhausted");
    assert.equal((await (await call(`/promo/${code}/status`)).json()).reason, "exhausted");
  });

  test("the stored submission carries the customer's ref_code for the bot", async () => {
    const { code, ref_code } = await (await trial("@some_user")).json();
    const { id } = await (await call("/submit", { method: "POST", form: submitForm(code) })).json();
    const stored = await (await call(`/submission/${id}`, { headers: { Authorization: "Bearer api-secret" } })).json();
    assert.equal(stored.ref_code, ref_code);
  });

  test("a rejected upload neither costs a post nor starts the trial", async () => {
    const { code } = await (await trial("@some_user")).json();
    const form = submitForm(code);
    form.set("media", new File([new Uint8Array(21 * 1024 * 1024)], "big.jpg", { type: "image/jpeg" }));
    const res = await call("/submit", { method: "POST", form });
    assert.equal(res.status, 400);

    const status = await (await call(`/promo/${code}/status`)).json();
    assert.equal(status.posts_left, 5);
    assert.equal(status.started, false);
  });

  test("admin can issue a code with a post cap", async () => {
    await call("/promo", { method: "POST", headers: ADMIN, json: { code: "CAPPED", trial_days: 5, max_posts: 1 } });
    assert.equal((await call("/submit", { method: "POST", form: submitForm("CAPPED") })).status, 200);
    assert.equal((await call("/submit", { method: "POST", form: submitForm("CAPPED") })).status, 403);
  });
});

describe("referrals", () => {
  async function activate(code) {
    const res = await call("/submit", { method: "POST", form: submitForm(code) });
    assert.equal(res.status, 200);
  }

  test("the referrer is rewarded on the friend's first post, once", async () => {
    const a = await (await trial("@referrer_a")).json();
    const b = await (await trial("@friend_bb", { ref: a.ref_code, v: "2" })).json();

    // Signing up alone earns nothing.
    let aStatus = await (await call(`/promo/${a.code}/status`)).json();
    assert.equal(aStatus.posts_left, 5);
    assert.equal(aStatus.days_left, 3);

    await activate(b.code);
    aStatus = await (await call(`/promo/${a.code}/status`)).json();
    assert.equal(aStatus.posts_left, 7, "+2 posts");
    assert.equal(aStatus.days_left, 5, "+2 days");

    await activate(b.code); // the friend's second post must not pay again
    aStatus = await (await call(`/promo/${a.code}/status`)).json();
    assert.equal(aStatus.posts_left, 7);
  });

  test("an unknown ref is ignored, not an error", async () => {
    const res = await trial("@friend_bb", { ref: "zzzzzzzz" });
    assert.equal(res.status, 200);
  });

  test("rewards are capped per referrer", async () => {
    env.REFERRAL_MAX_REWARDS = "1";
    const a = await (await trial("@referrer_a")).json();
    const b = await (await trial("@friend_bb", { ref: a.ref_code })).json();
    const c = await (await trial("@friend_cc", { ref: a.ref_code })).json();
    await activate(b.code);
    await activate(c.code);
    const aStatus = await (await call(`/promo/${a.code}/status`)).json();
    assert.equal(aStatus.posts_left, 7, "only the first activation paid");
  });
});

describe("tracked attribution link + funnel stats", () => {
  test("redirects to the site with ref and variant, and counts a real click", async () => {
    const { ref_code } = await (await trial("@referrer_a")).json();
    const res = await call(`/r/${ref_code}?v=3`);
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("Location"));
    assert.equal(location.searchParams.get("ref"), ref_code);
    assert.equal(location.searchParams.get("v"), "3");

    const stats = await (await call("/admin/stats", { headers: ADMIN })).json();
    assert.equal(stats.variants["3"].clicks, 1);
  });

  test("link-preview bots are redirected but not counted", async () => {
    const { ref_code } = await (await trial("@referrer_a")).json();
    const res = await call(`/r/${ref_code}?v=3`, { headers: { "User-Agent": "TelegramBot (like TwitterBot)" } });
    assert.equal(res.status, 302);
    const stats = await (await call("/admin/stats", { headers: ADMIN })).json();
    assert.equal(stats.variants["3"], undefined);
  });

  test("click sampling: rate 0 records nothing; a fractional rate records weighted clicks", async () => {
    const { ref_code } = await (await trial("@referrer_a")).json();

    env.CLICK_SAMPLE_RATE = "0";
    assert.equal((await call(`/r/${ref_code}?v=1`)).status, 302, "still redirects");
    assert.equal((await (await call("/admin/stats", { headers: ADMIN })).json()).variants["1"], undefined);

    env.CLICK_SAMPLE_RATE = "0.25";
    const realRandom = Math.random;
    try {
      Math.random = () => 0.1; // below the rate: counted, weighted 1/0.25
      await call(`/r/${ref_code}?v=1`);
      Math.random = () => 0.9; // above the rate: skipped
      await call(`/r/${ref_code}?v=1`);
    } finally {
      Math.random = realRandom;
    }
    assert.equal((await (await call("/admin/stats", { headers: ADMIN })).json()).variants["1"].clicks, 4);
  });

  test("unknown or reserved refs still land on the site, without a ref param", async () => {
    for (const ref of ["_", "nosuchref"]) {
      const res = await call(`/r/${ref}?v=1`);
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get("Location"));
      assert.equal(location.searchParams.get("ref"), null);
      assert.equal(location.searchParams.get("v"), "1");
    }
  });

  test("funnel: clicks -> signups -> activations per variant, with referrer leaderboard", async () => {
    const a = await (await trial("@referrer_a")).json();
    await call(`/r/${a.ref_code}?v=2`);
    await call(`/r/${a.ref_code}?v=2`);
    const b = await (await trial("@friend_bb", { ref: a.ref_code, v: "2" })).json();
    await call("/submit", { method: "POST", form: submitForm(b.code) });

    const stats = await (await call("/admin/stats", { headers: ADMIN })).json();
    assert.deepEqual(
      { clicks: stats.variants["2"].clicks, signups: stats.variants["2"].signups, activations: stats.variants["2"].activations },
      { clicks: 2, signups: 1, activations: 1 }
    );
    assert.equal(stats.variants["2"].click_to_signup_pct, 50);
    assert.equal(stats.top_referrers[0].ref, a.ref_code);
    assert.equal(stats.top_referrers[0].contact, "@referrer_a");
    assert.equal(stats.top_referrers[0].activations, 1);
  });

  test("stats need the admin token", async () => {
    assert.equal((await call("/admin/stats")).status, 401);
  });

  test("a failing counter never breaks the redirect", async () => {
    const { ref_code } = await (await trial("@referrer_a")).json();
    const realPut = env.MULTI_SENDER_KV.put.bind(env.MULTI_SENDER_KV);
    env.MULTI_SENDER_KV.put = async (key, ...rest) => {
      if (key === "stats:funnel") throw new Error("KV put() limit exceeded for the day");
      return realPut(key, ...rest);
    };
    assert.equal((await call(`/r/${ref_code}?v=1`)).status, 302);
  });
});

describe("packs and payments", () => {
  let realFetch;
  let gatewayCalls;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    gatewayCalls = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      gatewayCalls.push({ url: String(url), body });
      if (String(url).endsWith("/payment/request.json")) return Response.json({ data: { code: 100, authority: "A00000000000000000000000000012345" }, errors: [] });
      if (String(url).endsWith("/payment/verify.json")) return Response.json({ data: { code: 100, ref_id: 987654 }, errors: [] });
      throw new Error(`unexpected outbound fetch: ${url}`);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const enablePayments = () => {
    env.ZARINPAL_MERCHANT_ID = "merchant-1";
    env.ZARINPAL_SANDBOX = "true";
    env.PLAN_PRICES_TOMAN = JSON.stringify({ pack50: 99000 });
  };

  async function startCheckout() {
    const res = await call("/checkout", { method: "POST", json: { plan_id: "pack50", contact: "@buyer_one" } });
    assert.equal(res.status, 200);
    return res.json();
  }

  test("plans also expose the live trial/referral numbers, following the vars", async () => {
    let body = await (await call("/plans")).json();
    assert.deepEqual(body.trial, { days: 3, max_posts: 5 });
    assert.deepEqual(body.referral, { bonus_days: 2, bonus_posts: 2, max_rewards: 10 });
    env.TRIAL_DAYS = "7";
    env.REFERRAL_BONUS_POSTS = "4";
    body = await (await call("/plans")).json();
    assert.equal(body.trial.days, 7);
    assert.equal(body.referral.bonus_posts, 4);
  });

  test("by default no pack is purchasable (prices show as contact-support)", async () => {
    const body = await (await call("/plans")).json();
    assert.equal(body.payments_enabled, false);
    assert.equal(body.plans.length, 2);
    for (const plan of body.plans) {
      assert.equal(plan.price_toman, null);
      assert.equal(plan.purchasable, false);
    }
    const checkout = await call("/checkout", { method: "POST", json: { plan_id: "pack50" } });
    assert.equal(checkout.status, 503);
    assert.equal(gatewayCalls.length, 0, "must not contact the gateway when disabled");
  });

  test("a price without a merchant id (or vice versa) is still not purchasable", async () => {
    env.PLAN_PRICES_TOMAN = JSON.stringify({ pack50: 99000 });
    assert.equal((await (await call("/plans")).json()).plans[0].purchasable, false);
    delete env.PLAN_PRICES_TOMAN;
    env.ZARINPAL_MERCHANT_ID = "merchant-1";
    assert.equal((await (await call("/plans")).json()).plans[0].purchasable, false);
  });

  test("a malformed price var degrades to contact-support instead of erroring", async () => {
    env.ZARINPAL_MERCHANT_ID = "merchant-1";
    env.PLAN_PRICES_TOMAN = "{not json";
    const res = await call("/plans");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).plans[0].purchasable, false);
  });

  test("only priced packs are purchasable once payments are on", async () => {
    enablePayments();
    const { plans } = await (await call("/plans")).json();
    assert.equal(plans.find((p) => p.id === "pack50").purchasable, true);
    assert.equal(plans.find((p) => p.id === "pack50").price_toman, 99000);
    assert.equal(plans.find((p) => p.id === "pack200").purchasable, false);
  });

  test("full purchase: checkout -> gateway -> callback -> verified -> code works", async () => {
    enablePayments();
    const { order_id, pay_url } = await startCheckout();
    assert.match(order_id, /^[a-f0-9]{24}$/);
    assert.equal(pay_url, "https://sandbox.zarinpal.com/pg/StartPay/A00000000000000000000000000012345");

    const request = gatewayCalls[0];
    assert.equal(request.url, "https://sandbox.zarinpal.com/pg/v4/payment/request.json");
    assert.equal(request.body.amount, 990000, "toman -> rials");
    assert.equal(request.body.callback_url, `https://worker.test/pay/callback?order=${order_id}`);

    // Not paid yet: the order exists but exposes no code.
    const pending = await (await call(`/order/${order_id}`)).json();
    assert.equal(pending.status, "pending");
    assert.equal(pending.code, undefined);

    const callback = await call(`/pay/callback?order=${order_id}&Authority=A00000000000000000000000000012345&Status=OK`);
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get("Location"), new RegExp(`pay-result\\.html\\?order=${order_id}$`));
    assert.equal(gatewayCalls[1].url, "https://sandbox.zarinpal.com/pg/v4/payment/verify.json");
    assert.equal(gatewayCalls[1].body.amount, 990000);

    const paid = await (await call(`/order/${order_id}`)).json();
    assert.equal(paid.status, "paid");
    assert.match(paid.code, /^PK-[A-Z2-9]{8}$/);
    assert.equal(paid.posts, 50);

    const status = await (await call(`/promo/${paid.code}/status`)).json();
    assert.equal(status.posts_left, 50);
    assert.equal(status.days_left, 365);
    assert.equal(status.kind, "pack");
    const submitted = await (await call("/submit", { method: "POST", form: submitForm(paid.code) })).json();
    assert.equal(submitted.posts_left, 49);
  });

  test("a reloaded callback does not mint a second code or re-verify", async () => {
    enablePayments();
    const { order_id } = await startCheckout();
    const url = `/pay/callback?order=${order_id}&Authority=A00000000000000000000000000012345&Status=OK`;
    await call(url);
    const first = (await (await call(`/order/${order_id}`)).json()).code;
    await call(url);
    assert.equal((await (await call(`/order/${order_id}`)).json()).code, first);
    assert.equal(gatewayCalls.filter((c) => c.url.endsWith("verify.json")).length, 1);
  });

  test("abandoned or mismatched payments never produce a code", async () => {
    enablePayments();
    for (const query of ["Authority=A00000000000000000000000000012345&Status=NOK", "Authority=WRONG&Status=OK"]) {
      const { order_id } = await startCheckout();
      await call(`/pay/callback?order=${order_id}&${query}`);
      const order = await (await call(`/order/${order_id}`)).json();
      assert.equal(order.status, "failed");
      assert.equal(order.code, undefined);
    }
  });

  test("a gateway that refuses verification yields no code", async () => {
    enablePayments();
    const { order_id } = await startCheckout();
    globalThis.fetch = async () => Response.json({ data: { code: -50 }, errors: { code: -50 } });
    await call(`/pay/callback?order=${order_id}&Authority=A00000000000000000000000000012345&Status=OK`);
    assert.equal((await (await call(`/order/${order_id}`)).json()).status, "failed");
  });

  test("the amount is verified as it was at checkout even if the price changes meanwhile", async () => {
    enablePayments();
    const { order_id } = await startCheckout();
    env.PLAN_PRICES_TOMAN = JSON.stringify({ pack50: 149000 });
    await call(`/pay/callback?order=${order_id}&Authority=A00000000000000000000000000012345&Status=OK`);
    assert.equal(gatewayCalls[1].body.amount, 990000);
  });

  test("order lookup rejects malformed ids", async () => {
    assert.equal((await call("/order/not-an-id")).status, 404);
  });

  test("admin can mint a pack for a sale closed through support", async () => {
    assert.equal((await call("/admin/issue-pack", { method: "POST", json: { plan_id: "pack50" } })).status, 401);
    const bad = await call("/admin/issue-pack", { method: "POST", headers: ADMIN, json: { plan_id: "nope" } });
    assert.equal(bad.status, 400);

    const res = await call("/admin/issue-pack", { method: "POST", headers: ADMIN, json: { plan_id: "pack200", contact: "@buyer" } });
    const body = await res.json();
    assert.match(body.code, /^PK-/);
    assert.equal(body.posts, 200);
    assert.equal((await (await call(`/promo/${body.code}/status`)).json()).posts_left, 200);
  });
});

describe("auto-replies no longer promise manually created codes", () => {
  test("the Rubika greeting points at the self-serve flow", async () => {
    env.RUBIKA_WEBHOOK_SECRET = "s3cret";
    env.RUBIKA_BOT_TOKEN = "tok";
    const realFetch = globalThis.fetch;
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = JSON.parse(init.body);
      return Response.json({ ok: true });
    };
    try {
      await call("/webhook/rubika/s3cret", { method: "POST", json: { update: { type: "StartedBot", chat_id: "c1" } } });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.match(sent.text, /خودکار/);
    assert.doesNotMatch(sent.text, /از پشتیبانی بگیرید/);
  });
});
