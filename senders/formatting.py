def format_item(item):
    if item.raw_text:
        return item.raw_text
    parts = []
    if item.title:
        parts.append(item.title)
    if item.description:
        parts.append(item.description)
    if item.price:
        parts.append(f"Price: {item.price}")
    if item.location:
        parts.append(f"Location: {item.location}")
    if item.url:
        parts.append(item.url)
    return "\n".join(parts)
