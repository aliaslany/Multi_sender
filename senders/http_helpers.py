import requests


def post_json(url, payload, timeout=20):
    response = requests.post(url, json=payload, timeout=timeout)
    response.raise_for_status()
    return response.json()
