"""Interface every source module must implement.

A "source" is anything that can be polled for new content: Divar, another
classifieds site, an RSS feed, or - as with telegram_relay - Telegram itself.
To add a new one, create a module under sources/ with a `SOURCE = MySource()`
instance that implements this interface, then point SOURCE_TYPE at it in
config.

Keeping this interface small on purpose:
  - fetch_new_ids(state) -> cheap call, just the ids of current items.
    Receives the persisted state dict so sources that need to remember a
    cursor/offset between runs (like telegram_relay's update offset) can
    read and write state["source_state"][self.name] themselves. Sources
    that don't need this (like Divar) just ignore the argument.
  - fetch_item(id)        -> full details for a single id, mapped to
    core.models.Item

main.py's orchestration loop only ever talks to these two methods plus
target_senders, so it has zero knowledge of Divar, Telegram, Bale, etc.
"""
from abc import ABC, abstractmethod

from core.models import Item


class Source(ABC):
    name: str = "base"

    # Which senders this source's items should be delivered to.
    # None (the default) means "every configured sender". A list restricts
    # delivery to just those sender names - e.g. telegram_relay only wants
    # ["rubika", "eitaa"], since the post already exists on Telegram itself.
    target_senders: list[str] | None = None

    @abstractmethod
    def fetch_new_ids(self, state: dict) -> list[str]:
        """Return ids for the current batch of new items, oldest first."""
        raise NotImplementedError

    @abstractmethod
    def fetch_item(self, item_id: str) -> Item | None:
        """Return the full Item for one id, or None if it couldn't be
        fetched/parsed (source implementations should log why and return
        None rather than raising, so one bad item doesn't kill the run)."""
        raise NotImplementedError
