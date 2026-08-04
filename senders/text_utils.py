"""Shared helpers for dealing with each platform's message-length limits.

Telegram (and Bale, which mirrors Telegram's API) reject requests outright
if you go over these limits — a photo/album with a too-long caption fails
the whole send, which is why long ad descriptions were silently never
delivered before. Rubika and Eitaa don't document a hard number, so we
reuse a conservative shared limit for them too.
"""

TELEGRAM_CAPTION_LIMIT = 1024  # photo / media-group caption
TELEGRAM_MESSAGE_LIMIT = 4096  # plain text message
DEFAULT_MESSAGE_LIMIT = 4000  # conservative fallback for Rubika/Eitaa


def split_text_into_chunks(text: str, limit: int) -> list[str]:
    """Splits text into pieces no longer than `limit`, preferring to break
    on newlines so we never cut a formatting tag or word in half. Falls
    back to a hard character split only if a single line still exceeds
    `limit` on its own (e.g. a very long, un-wrapped description)."""
    if len(text) <= limit:
        return [text]

    chunks = []
    current = ""
    for line in text.split("\n"):
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) <= limit:
            current = candidate
            continue

        if current:
            chunks.append(current)
            current = ""

        while len(line) > limit:
            chunks.append(line[:limit])
            line = line[limit:]
        current = line

    if current:
        chunks.append(current)
    return chunks
