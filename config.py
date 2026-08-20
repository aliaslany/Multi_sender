import os
from dataclasses import dataclass


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def csv_env(name: str) -> list[str]:
    return [x.strip() for x in env(name).split(",") if x.strip()]


@dataclass(frozen=True)
class Config:
    telegram_bot_token: str = env("TELEGRAM_BOT_TOKEN")
    telegram_relay_bot_token: str = env("TELEGRAM_RELAY_BOT_TOKEN")
    telegram_relay_chat_ids: list[str] = None
    rubika_bot_token: str = env("RUBIKA_BOT_TOKEN")
    eitaa_bot_token: str = env("EITAA_BOT_TOKEN")
    bale_bot_token: str = env("BALE_BOT_TOKEN")

    def __post_init__(self):
        if self.telegram_relay_chat_ids is None:
            object.__setattr__(self, "telegram_relay_chat_ids", csv_env("TELEGRAM_RELAY_CHAT_IDS"))


config = Config()
