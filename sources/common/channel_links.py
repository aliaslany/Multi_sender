"""Builds the 'follow us elsewhere' footer links shared by relay-style
sources (telegram_relay, website). Kept separate from any one source since
more than one wants the same footer.
"""
import config
from core.models import ChannelLink


def cross_promotion_links() -> list[ChannelLink]:
    urls = [
        config.TELEGRAM_CHANNEL_URL,
        config.BALE_CHANNEL_URL,
        config.RUBIKA_CHANNEL_URL,
    ]
    return [ChannelLink(label=config.CHANNEL_LINK_LABEL, url=url) for url in urls if url]
