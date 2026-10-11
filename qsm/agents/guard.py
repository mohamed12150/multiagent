"""Outbound text guard: anything the network publishes or sends alone is checked for links, numbers and prices
the brand does not own — a customer (or a web page) may have planted them through the model."""
from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlparse

from .. import settings

# Anything that looks like a host (with or without a scheme), e.g. "bit.ly/x", "https://a.b", "evil-pay.test/refund".
HOST_RE = re.compile(r"(?:https?://)?((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62})(?::\d+)?(?:[/?#]\S*)?", re.IGNORECASE)
DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
MONEY_RE = re.compile(r"\d+(?:[.,]\d+)?\s?(%|٪|ريال|ر\.س|SAR|sar|ر\.\s?س)")


def _brand_host(brand: settings.Brand) -> str:
    raw = (brand.website or "").strip().lower()
    if not raw:
        return ""
    host = urlparse(raw if "://" in raw else f"https://{raw}").hostname or ""
    return host.removeprefix("www.")


def risky(reply_text: str, brand: settings.Brand) -> str:
    """Why an auto-reply must wait for the owner: a link or number the brand does not own (a customer may have
    planted it), or a price/discount the brand file does not contain. Hosts match exactly (or as a subdomain)."""
    text_ = unicodedata.normalize("NFKC", reply_text).translate(DIGITS)
    site = _brand_host(brand)
    for m in HOST_RE.finditer(text_):
        host = m.group(1).lower().removeprefix("www.")
        if not site or not (host == site or host.endswith("." + site)):
            return "يحتوي رابطًا خارجيًا"
    own = re.sub(r"\D", "", (brand.phone or "").translate(DIGITS))
    compact = re.sub(r"[\s.\-()/]", "", text_)
    for digits in re.findall(r"\+?\d{7,}", compact):
        number = digits.lstrip("+")
        if not own or (number not in own and own[-9:] not in number):
            return "يحتوي رقمًا غير رقم الشركة"
    known = unicodedata.normalize("NFKC", " ".join(
        [brand.description, brand.dos, *[f"{p.name} {p.price} {p.description}" for p in brand.products]])).translate(DIGITS)
    known_amounts = set(re.findall(r"\d+(?:[.,]\d+)?", known))
    for m in MONEY_RE.finditer(text_):
        amount = re.match(r"\d+(?:[.,]\d+)?", m.group(0)).group(0)
        if amount not in known_amounts:
            return "يذكر سعرًا أو خصمًا غير موجود في ملف العلامة"
    return ""
