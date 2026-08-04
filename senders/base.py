"""Interface every sender (messenger) module must implement.

A "sender" delivers one Item to one destination: a Telegram chat, a Bale
chat, a webhook, an email list, whatever. To add a new one, create a class
implementing this interface and register it in senders/registry.py.

main.py's orchestration loop only ever talks to .name / .enabled() / .send(),
so it has zero knowledge of Telegram's API vs Bale's vs anything else.
"""
from abc import ABC, abstractmethod

from core.models import Item


class Sender(ABC):
    name: str = "base"

    @abstractmethod
    def enabled(self) -> bool:
        """Whether this sender has the config it needs (token/chat id/etc)."""
        raise NotImplementedError

    @abstractmethod
    async def send(self, item: Item) -> bool:
        """Deliver one item. Return True on success, False on failure -
        never raise, so one platform's failure doesn't block the others."""
        raise NotImplementedError
