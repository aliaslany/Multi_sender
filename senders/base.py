from abc import ABC, abstractmethod


class Sender(ABC):
    name = "base"

    @abstractmethod
    def send(self, item):
        raise NotImplementedError
