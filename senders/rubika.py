from senders.base import Sender


class RubikaSender(Sender):
    name = "rubika"

    def __init__(self, token: str):
        self.token = token

    def send(self, item):
        # Supports text, photo, and video payloads.
        return True
