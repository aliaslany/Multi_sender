# Submission Worker

This is the small backend behind `docs/index.html`. It's the *only* place
that ever sees a promo code or a destination chat id — no bot tokens, no
GitHub credentials, nothing sensitive passes through it. See the comment
block at the top of `src/index.js` for the full endpoint list.

## One-time deploy

```bash
npm install -g wrangler
cd worker
wrangler login                      # opens a browser to authorize once
wrangler secret put API_TOKEN       # pick any long random string - the bot uses this
wrangler secret put ADMIN_TOKEN     # a different long random string - only you use this
wrangler deploy
```

`wrangler deploy` prints your Worker's URL, something like
`https://multi-sender-submissions.<your-subdomain>.workers.dev`. You need it
in two places:

1. **`docs/index.html`** — replace the `API_BASE` constant near the top of
   the `<script>` block with this URL.
2. **Repo secrets** (Settings → Secrets and variables → Actions):
   - `WEBSITE_API_URL` = that same URL
   - `WEBSITE_API_TOKEN` = the same value you set for `API_TOKEN` above

The KV namespace (`multi_sender_submissions`, id in `wrangler.toml`) is
already created — `wrangler.toml` just needs to point at it, which it does.

## Creating a promo code

Each code has its own trial window, which starts counting from the first
time it's actually used (not when you create it):

```bash
curl -X POST https://<your-worker-url>/promo \
  -H "Authorization: Bearer <your ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"code": "SUMMER7", "trial_days": 7}'
```

Give `SUMMER7` (or whatever you name it) to a customer — that's the only
thing they need to enter besides their own channel's chat id. There's no
way to look up or list existing codes yet; keep a note of what you create
if that matters to you.

## Updating the Worker later

Edit `src/index.js`, then just run `wrangler deploy` again from this
directory. Secrets you've already set persist across deploys.
