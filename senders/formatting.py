"""Turns a generic Item into message text. Shared by every sender so
formatting stays consistent across platforms; only escaping/markup differs.
"""
import html

import config
from core.models import Item


def _price_line(item: Item) -> str:
    return "{:,} تومان".format(item.price) if item.price else "توافقی"


def build_message_text(item: Item, escape: bool = True) -> str:
    """Full message text. escape=True HTML-escapes for Telegram/Bale;
    escape=False produces a portable plain-text version for Rubika/Eitaa."""
    if item.raw_text is not None:
        # The source already wrote finished text (e.g. a relayed Telegram
        # post) - send it exactly as-is, no template, no footer.
        return html.escape(item.raw_text) if escape else item.raw_text

    esc = html.escape if escape else (lambda s: s)
    b_open, b_close = ("<b>", "</b>") if escape else ("", "")
    i_open, i_close = ("<i>", "</i>") if escape else ("", "")

    text = f"🗄 {b_open}{esc(item.title)}{b_close}\n"

    if item.location:
        text += f"📌 محل آگهی : {i_open}{esc(item.location)}{i_close}\n"

    text += f"💰 قیمت : {_price_line(item)}\n"

    if item.features:
        text += "\n📋 مشخصات :\n"
        for label, value in item.features:
            text += f"🔸 {esc(label)}: {esc(value)}\n"

    text += f"\n📄 توضیحات :\n{esc(item.description)}"

    if item.tags:
        text += "\n\n" + " ".join(f"#{tag}" for tag in item.tags)

    text += config.FOOTER_TEXT
    return text


def build_short_caption(item: Item, escape: bool = True) -> str:
    """Short teaser used as a photo/video caption when the full text would
    exceed a platform's caption limit; full text follows as its own message."""
    esc = html.escape if escape else (lambda s: s)

    if item.raw_text is not None:
        teaser = item.raw_text if len(item.raw_text) <= 200 else item.raw_text[:197] + "..."
        return esc(teaser)

    b_open, b_close = ("<b>", "</b>") if escape else ("", "")
    return (
        f"🗄 {b_open}{esc(item.title)}{b_close}\n"
        f"💰 قیمت : {_price_line(item)}\n\n"
        "(توضیحات کامل در پیام بعدی 👇)"
    )
