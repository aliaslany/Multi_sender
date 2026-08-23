"""Pulls a random nature-themed (طبیعت) Persian quote from the persian-quotes
dataset (github.com/aliaslany/persian-quotes) to append to relayed posts.

Fetched fresh each run rather than bundled with this repo, so the quote
pool can grow independently. jsDelivr is tried first (CDN, fast, cached);
raw.githubusercontent.com is the fallback (always current, uncached).
"""
import random

import requests

import config

_cache: list[dict] | None = None


def _fetch_quotes() -> list[dict]:
    global _cache
    if _cache is not None:
        return _cache

    for url in (config.NATURE_QUOTES_URL, config.NATURE_QUOTES_FALLBACK_URL):
        if not url:
            continue
        try:
            response = requests.get(url, timeout=config.MESSENGER_REQUEST_TIMEOUT)
            response.raise_for_status()
            quotes = response.json()
            if isinstance(quotes, list) and quotes:
                _cache = quotes
                return _cache
        except (requests.RequestException, ValueError) as error:
            print("sources.common.quotes: could not fetch quotes from {}: {}".format(url, error))

    _cache = []
    return _cache


def random_nature_quote() -> str | None:
    """Return one quote formatted as 'text\n— author', or None if the
    dataset couldn't be fetched (callers should treat that as optional)."""
    quotes = _fetch_quotes()
    if not quotes:
        return None
    quote = random.choice(quotes)
    text = quote.get("text", "").strip()
    author = quote.get("author", "").strip()
    if not text:
        return None
    return "{}\n— {}".format(text, author) if author else text
