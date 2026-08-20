from sources.divar.client import DivarSource
from sources.telegram_relay.client import TelegramRelaySource


def build_sources(config):
    sources = []
    if config.telegram_relay_bot_token and config.telegram_relay_chat_ids:
        sources.append(TelegramRelaySource(config.telegram_relay_bot_token, config.telegram_relay_chat_ids))
    sources.append(DivarSource())
    return sources
