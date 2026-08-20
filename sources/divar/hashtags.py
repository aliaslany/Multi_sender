def extract_hashtags(text: str) -> list[str]:
    return [word for word in (text or "").split() if word.startswith("#")]
