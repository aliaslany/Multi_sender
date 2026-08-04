"""Everything related to talking to Divar's (unofficial) web API and
parsing the responses into plain Python data."""
import datetime
import json

import requests
from pydantic import BaseModel

import config


class AD(BaseModel):
    title: str
    price: int
    description: str = ""
    district: str
    images: list[str] = []
    token: str
    features: list[tuple[str, str]] = []  # e.g. [("متراژ ویلا", "۱۰۰"), ...]
    posted_in: str = ""  # e.g. "علی‌آباد کتول، خ ابر-شیرین آباد-علی آباد"
    breadcrumb_categories: list[str] = []  # e.g. ["اجارهٔ کوتاه‌مدت", ...]


_debug_dumped_once = False


def build_search_body():
    """Builds the JSON body for Divar's postlist search API (first page only)."""
    return {
        "city_ids": config.SEARCH_CITY_IDS,
        "search_data": {
            "form_data": {
                "data": {"category": {"str": {"value": config.SEARCH_CATEGORY}}}
            },
            "server_payload": {
                "@type": "type.googleapis.com/widgets.SearchData.ServerPayload",
                "additional_form_data": {
                    "data": {"sort": {"str": {"value": "sort_date"}}}
                },
            },
        },
        "disable_recommendation": False,
        "map_state": {"camera_info": {"bbox": {}}},
        "current_tab_slug": "default",
    }


def get_data():
    body = build_search_body()
    response = requests.post(
        config.DIVAR_SEARCH_URL, headers=config.REQUEST_HEADERS, json=body
    )
    print(
        "{} - Got response: {}".format(datetime.datetime.now(), response.status_code)
    )
    response.raise_for_status()
    return response.json()


def get_ads_list(data):
    # Divar returns posts under "list_widgets"
    return data.get("list_widgets", [])


def get_tokens_page():
    data = get_data()
    data = get_ads_list(data)
    print("Raw list_widgets length: {}".format(len(data)))
    data = data[::-1]
    # get tokens - only real post rows (skip banners, blocking views, etc.)
    data = filter(lambda x: x.get("widget_type") == "POST_ROW", data)
    tokens = list(map(lambda x: x["data"]["token"], data))
    return tokens


def extract_features(sections):
    """Walks the LIST_DATA section (and any nested amenities modal inside it)
    and returns a list of (label, value) pairs for every structured field
    Divar shows on the ad page (metrage, capacity, rent prices, amenities...).
    """
    features = []

    def process_widgets(widgets):
        pending_label = None
        for w in widgets:
            wtype = w.get("widget_type")
            data = w.get("data", {})

            if wtype == "GROUP_INFO_ROW":
                for item in data.get("items", []):
                    t, v = item.get("title", ""), item.get("value", "")
                    if t and v:
                        features.append((t, v))

            elif wtype == "UNEXPANDABLE_ROW":
                t, v = data.get("title", ""), data.get("value", "")
                if t and v:
                    features.append((t, v))

            elif wtype == "DESCRIPTION_ROW":
                # usually a label for a following chip list (e.g. "چشم‌انداز")
                pending_label = data.get("text", "")

            elif wtype == "WRAPPER_ROW":
                chips = data.get("chip_list", {}).get("chips", [])
                chip_texts = [c.get("text", "") for c in chips if c.get("text")]
                if chip_texts:
                    features.append((pending_label or "ویژگی", "، ".join(chip_texts)))
                pending_label = None

            elif wtype == "SELECTOR_ROW":
                # amenities are often tucked inside a modal opened by this row
                modal = data.get("action", {}).get("payload", {}).get("modal_page", {})
                nested = modal.get("widget_list")
                if nested:
                    process_widgets(nested)

            # SECTION_TITLE_ROW and others are just headers/dividers -> skip

    for section in sections:
        if section.get("section_name") == "LIST_DATA":
            process_widgets(section.get("widgets", []))

    return features


def extract_posted_in(sections):
    """Pulls the '<n> هفته پیش در <location>' line shown under the title."""
    for section in sections:
        if section.get("section_name") == "TITLE":
            for w in section.get("widgets", []):
                if w.get("widget_type") == "EXPANDABLE_SECTION":
                    return w.get("data", {}).get("title", "")
    return ""


def extract_breadcrumb_categories(sections):
    """Pulls the category chain shown in the BREADCRUMB section, e.g.
    ["املاک", "اجارهٔ کوتاه‌مدت", "اجارهٔ کوتاه‌مدت ویلا و باغ"]."""
    titles = []
    for section in sections:
        if section.get("section_name") == "BREADCRUMB":
            for w in section.get("widgets", []):
                if w.get("widget_type") == "BREADCRUMB":
                    for item in w.get("data", {}).get("parent_items", []):
                        t = item.get("title")
                        if t:
                            titles.append(t)
    return titles


def fetch_ad_data(token: str) -> AD:
    response = requests.get(
        config.DIVAR_POST_DETAIL_URL.format(token=token),
        headers=config.REQUEST_HEADERS,
    )
    data = response.json()
    images = []
    if "sections" not in data:
        print(
            "Warning: unexpected response for token {} (status {}): {}".format(
                token, response.status_code, str(data)[:300]
            )
        )
        return None

    if config.DEBUG_DUMP_SECTIONS:
        global _debug_dumped_once
        if not _debug_dumped_once:
            _debug_dumped_once = True
            print("===== FULL SECTIONS DUMP for token {} =====".format(token))
            print(json.dumps(data["sections"], ensure_ascii=False))
            print("===== END DUMP =====")

    title = ""
    description = ""

    try:
        for section in data["sections"]:
            if section["section_name"] == "TITLE":
                title = section["widgets"][0]["data"]["title"]

            if section["section_name"] == "IMAGE":
                images = section["widgets"][0]["data"]["items"]
                images = [img["image"]["url"] for img in images]

            if section["section_name"] == "DESCRIPTION":
                description = section["widgets"][1]["data"]["text"]

        district = data.get("seo", {}).get("web_info", {}).get(
            "district_persian", ""
        )
        price = data.get("webengage", {}).get("price", 0) or 0

        features = extract_features(data["sections"])
        posted_in = extract_posted_in(data["sections"])
        breadcrumb_categories = extract_breadcrumb_categories(data["sections"])

        ad = AD(
            token=token,
            title=title,
            district=district,
            description=description,
            images=images,
            price=price,
            features=features,
            posted_in=posted_in,
            breadcrumb_categories=breadcrumb_categories,
        )
    except (KeyError, IndexError, TypeError) as e:
        print("Warning: failed to parse ad {} ({}), skipping.".format(token, e))
        return None

    return ad
