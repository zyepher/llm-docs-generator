"""Decode the `X-Signature` header, which our spec says is padded base64url."""
import base64
import binascii
import re


class BadSignature(ValueError):
    pass


_PADDED_B64URL = re.compile(r"(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}==|[A-Za-z0-9_-]{3}=)?")


def decode_signature(value: str) -> bytes:
    # Validate the shape explicitly instead of relying on the decoder to
    # reject unpadded input: whether it does depends on the Python version.
    if not _PADDED_B64URL.fullmatch(value):
        raise BadSignature("not padded base64url")
    try:
        return base64.urlsafe_b64decode(value)
    except (binascii.Error, ValueError) as e:
        raise BadSignature(str(e)) from e
