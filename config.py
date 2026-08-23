"""Central place for environment-driven configuration and constants."""
import os

# Which source module to poll for new listings. See sources/registry.py.
SOURCE_TYPE = os.environ.get("SOURCE_TYPE", "divar")

DIVAR_SEARCH_URL = "https://api.divar.ir/v8/postlist/w/search"
DIVAR_POST_DETAIL_URL = "https://api.divar.ir/v8/posts-v2/web/{token}"

BOT_TOKEN = os.environ.get("BOT_TOKEN")
BOT_CHATID = os.environ.get("BOT_CHATID")
BALE_BOT_TOKEN = os.environ.get("BALE_BOT_TOKEN")
BALE_CHATID = os.environ.get("BALE_CHATID")
RUBIKA_BOT_TOKEN = os.environ.get("RUBIKA_BOT_TOKEN")
RUBIKA_CHATID = os.environ.get("RUBIKA_CHATID")
EITAA_TOKEN = os.environ.get("EITAA_TOKEN")
EITAA_CHATID = os.environ.get("EITAA_CHATID")

# Which Telegram chats the telegram_relay source will accept posts from -
# your own user id (for DMing the bot) and/or a channel's numeric id
# (e.g. -1001234567890, for the bot reading channel posts as an admin).
# Comma-separated. Required for telegram_relay - without it the source
# refuses to guess and processes nothing, so a stray DM can't get relayed.
TELEGRAM_RELAY_CHAT_IDS = [
    int(c.strip())
    for c in os.environ.get("TELEGRAM_RELAY_CHAT_IDS", "").split(",")
    if c.strip()
]

# A random quote from this theme file is appended to each relayed post.
# Defaults to the "nature" (طبیعت) theme of github.com/aliaslany/persian-quotes.
# jsDelivr is tried first (CDN), raw.githubusercontent.com as a fallback.
NATURE_QUOTES_URL = os.environ.get(
    "NATURE_QUOTES_URL",
    "https://cdn.jsdelivr.net/gh/aliaslany/persian-quotes@main/data/quotes/tabiat.json",
)
NATURE_QUOTES_FALLBACK_URL = os.environ.get(
    "NATURE_QUOTES_FALLBACK_URL",
    "https://raw.githubusercontent.com/aliaslany/persian-quotes/main/data/quotes/tabiat.json",
)

# Used by the website source to build raw.githubusercontent.com URLs for
# media files committed by the GitHub Pages submission form.
GITHUB_REPO = os.environ.get("GITHUB_REPO", "aliaslany/Multi_sender")

# "Follow us elsewhere" footer links appended to relayed posts. Same label
# across platforms by design (brand consistency); only the destination
# differs. Set any of these empty to drop that platform from the footer.
CHANNEL_LINK_LABEL = os.environ.get("CHANNEL_LINK_LABEL", "طبیعت+")
TELEGRAM_CHANNEL_URL = os.environ.get("TELEGRAM_CHANNEL_URL", "https://t.me/nature_plus")
BALE_CHANNEL_URL = os.environ.get("BALE_CHANNEL_URL", "https://ble.ir/natureplus")
RUBIKA_CHANNEL_URL = os.environ.get("RUBIKA_CHANNEL_URL", "https://rubika.ir/natureplus1")

BALE_API_BASE_URL = os.environ.get("BALE_API_BASE_URL", "https://tapi.bale.ai")
RUBIKA_API_BASE_URL = os.environ.get(
    "RUBIKA_API_BASE_URL", "https://botapi.rubika.ir/v3"
)
EITAA_API_BASE_URL = os.environ.get("EITAA_API_BASE_URL", "https://eitaayar.ir/api")
MESSENGER_REQUEST_TIMEOUT = int(os.environ.get("MESSENGER_REQUEST_TIMEOUT", "30"))
SLEEP_SEC = os.environ.get("SLEEP_SEC", "")

# Comma-separated list of city IDs, e.g. "823,1996,1999"
SEARCH_CITY_IDS = [
    c.strip()
    for c in os.environ.get("SEARCH_CITY_IDS", "897").split(",")
    if c.strip()
]
SEARCH_CATEGORY = os.environ.get("SEARCH_CATEGORY", "real-estate")

PROXY_URL = os.environ.get("PROXY_URL") or None

DEBUG_DUMP_SECTIONS = os.environ.get("DEBUG_DUMP_SECTIONS", "") == "1"

REQUEST_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "referrer": "https://divar.ir/",
    "x-render-type": "CSR",
    "x-standard-divar-error": "true",
}

# Fixed footer appended to every outgoing message, across all senders.
# Override via env var so forks of this template don't have to edit code.
FOOTER_TEXT = os.environ.get(
    "FOOTER_TEXT",
    "\n\n📞 شماره تماس جهت هماهنگی:\n"
    "09922434338\n"
    "\u200c\n"
    "📢 [علی‌آباد مِلک | اولین مرجع املاک علی‌آباد کتول]\n"
    "🆔 @aliabadmelk",
)
