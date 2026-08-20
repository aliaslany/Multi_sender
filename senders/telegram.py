from senders.base import Sender


class TelegramSender(Sender):
    name = "telegram"

    def __init__(self, token: str):
        self.token = token

    def send(self, item):
        return True
