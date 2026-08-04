"""Builds the hashtag list appended to each Telegram message."""
import re

# --- Keyword-based hashtags ---------------------------------------------
# Each hashtag maps to a list of keywords/variants to search for in the
# ad's title, description, district, and posted_in text.
CATEGORY_HASHTAGS = {
    "مسکونی": ["مسکونی"],
    "آپارتمان": ["آپارتمان", "اپارتمان"],
    "ویلایی": ["ویلایی", "ویلا"],
    "باغ": ["باغ"],
    "زمین": ["زمین"],
    "کشاورزی": ["کشاورزی"],
    "تجاری": ["تجاری"],
    "مغازه": ["مغازه"],
    "اداری": ["اداری"],
}

LOCATION_HASHTAGS = {
    "فاضل_آباد": ["فاضل آباد", "فاضل‌آباد", "فاضلاباد"],
    "علی_آباد_کتول": ["علی آباد کتول", "علی‌آباد کتول", "علی اباد کتول", "علی آباد"],
    "مزرعه": ["مزرعه"],
}

DEAL_TYPE_HASHTAGS = {
    "اجاره": ["اجاره"],
    "رهن": ["رهن"],
    "فروش": ["فروش"],
}

ALL_KEYWORD_HASHTAG_GROUPS = [CATEGORY_HASHTAGS, LOCATION_HASHTAGS, DEAL_TYPE_HASHTAGS]


def _slugify_persian(text: str) -> str:
    """Turns a Persian phrase into a Telegram-safe hashtag body:
    spaces and ZWNJ become underscores so the hashtag isn't split."""
    text = text.strip()
    text = text.replace("\u200c", "_")  # ZWNJ (used as a pseudo-space in Persian)
    text = re.sub(r"\s+", "_", text)
    return text


def generate_hashtags(ad) -> list[str]:
    """Combines keyword-based hashtags (category/location/deal type detected
    from free text) with Divar's own breadcrumb category chain, and returns
    a deduplicated, order-preserving list of hashtags (without the '#')."""
    haystack = " ".join(
        [ad.title or "", ad.description or "", ad.district or "", ad.posted_in or ""]
    )

    tags = []

    # 1) keyword-based tags
    for group in ALL_KEYWORD_HASHTAG_GROUPS:
        for tag, keywords in group.items():
            if any(keyword in haystack for keyword in keywords):
                tags.append(tag)

    # 2) Divar's own breadcrumb category chain (e.g. "اجارهٔ کوتاه‌مدت ویلا و باغ")
    for category_title in getattr(ad, "breadcrumb_categories", []) or []:
        slug = _slugify_persian(category_title)
        if slug:
            tags.append(slug)

    # dedupe while preserving order
    seen = set()
    unique_tags = []
    for tag in tags:
        if tag not in seen:
            seen.add(tag)
            unique_tags.append(tag)
    return unique_tags
