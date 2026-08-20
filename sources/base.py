from abc import ABC, abstractmethod


class Source(ABC):
    name = "base"
    target_senders = None

    @abstractmethod
    def fetch_new_ids(self, state):
        raise NotImplementedError

    @abstractmethod
    def fetch(self, item_id):
        raise NotImplementedError
