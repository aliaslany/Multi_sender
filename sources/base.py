"""Interface every source module must implement.

A "source" is anything that can be polled for new listings: Divar, another
classifieds site, an RSS feed, a Twitter/X search, etc. To add a new one,
create a module under sources/ with a `SOURCE = MySource()` instance that
implements this interface, then point SOURCE_TYPE at it in config.

Keeping this interface tiny on purpose:
  - fetch_new_ids()  -> cheap call, just the ids of current listings
  - fetch_item(id)   -> full details for a single id, mapped to core.models.Item

main.py's orchestration loop only ever talks to these two methods, so it
has zero knowledge of Divar, Bale, or anything else.
"""
from abc import ABC, abstractmethod

from core.models import Item


class Source(ABC):
    name: str = "base"

    @abstractmethod
    def fetch_new_ids(self) -> list[str]:
        """Return ids for the current page of listings, oldest first."""
        raise NotImplementedError

    @abstractmethod
    def fetch_item(self, item_id: str) -> Item | None:
        """Return the full Item for one id, or None if it couldn't be
        fetched/parsed (source implementations should log why and return
        None rather than raising, so one bad listing doesn't kill the run)."""
        raise NotImplementedError
