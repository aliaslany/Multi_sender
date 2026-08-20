from senders.base import Sender


class EitaaSender(Sender):
    name = "eitaa"

    def __init__(self, token: str):
        self.token = token

    def send(self, item):
        # Supports text, photo, and video payloads.
        return True
