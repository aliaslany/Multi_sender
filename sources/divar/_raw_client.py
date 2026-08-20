import requests


class DivarClient:
    def __init__(self, base_url="https://api.divar.ir"):
        self.base_url = base_url

    def get(self, path, **kwargs):
        response = requests.get(self.base_url + path, timeout=20, **kwargs)
        response.raise_for_status()
        return response.json()
