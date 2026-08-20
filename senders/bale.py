from senders.base import Sender


class BaleSender(Sender):
    name = "bale"

    def __init__(self, token: str):
        self.token = token

    def send(self, item):
        # Implement Bale delivery here.
        return True
