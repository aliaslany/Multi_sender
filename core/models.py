from dataclasses import dataclass, field
from typing import Any


@dataclass
class Media:
    type: str
    url: str


@dataclass
class Item:
    id: str
    title: str = ""
    description: str = ""
    price: str = ""
    location: str = ""
    url: str = ""
    media: list[Media] = field(default_factory=list)
    raw_text: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
