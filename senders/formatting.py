"""Turns a generic Item into message text. Shared by every sender so
formatting stays consistent across platforms; only escaping/markup differs.
"""
import html
from typing import Literal

import config
from core.models import ChannelLink, Item

LinkStyle = Literal["html", "markdown", "plain"]


def _price_line(item: Item) -> str:
    return "{:,} تومان".format(item.price) if item.price else "توافقی"


def _render_channel_links(links: list[ChannelLink], link_style: LinkStyle) -> str:
    if not links:
        return ""

    if link_style == "html":
        rendered = " | ".join(
            '<a href="{}">{}</a>'.format(html.escape(link.url), html.escape(link.label)) for link in links
        )
    elif link_style == "markdown":
        rendered = " | ".join("[{}]({})".format(link.label, link.url) for link in links)
    else:
        rendered = " | ".join("{}: {}".format(link.label, link.url) for link in links)

    return "\n\n" + rendered


def build_message_text(item: Item, escape: bool = True, link_style: LinkStyle = "plain") -> str:
    """Full message text. escape=True HTML-escapes for Telegram/Bale;
    escape=False produces a portable plain-text version for Rubika/Eitaa.
    link_style controls how item.channel_links is rendered, independently
    of escape (e.g. Rubika wants escape=False body text but HTML links)."""
    if item.raw_text is not None:
        # The source already wrote finished text (e.g. a relayed Telegram
        # post) - send it exactly as-is, no template, no footer.
        text = html.escape(item.raw_text) if escape else item.raw_text
        return text + _render_channel_links(item.channel_links, link_style)

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
    text += _render_channel_links(item.channel_links, link_style)
    return text


def build_short_caption(item: Item, escape: bool = True) -> str:
    """Short teaser used as a photo/video caption when the full text would
    exceed a platform's caption limit; full text follows as its own message.
    Channel links are omitted here since the full text (with links) follows."""
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
