"""Decode the `X-Signature` header, which our spec says is padded base64url."""
import base64
import binascii


class BadSignature(ValueError):
    pass


def decode_signature(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value)
    except (binascii.Error, ValueError) as e:
        raise BadSignature(str(e)) from e
