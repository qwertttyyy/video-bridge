import base64
import hashlib
import hmac

from turn_credentials import generate_turn_credentials


def test_generate_turn_credentials_uses_coturn_rest_api_format():
    secret = "shared-secret"
    username, credential = generate_turn_credentials(
        secret=secret,
        ttl_seconds=3600,
        user_label="tester",
    )

    expiry, label = username.split(":", 1)
    assert expiry.isdigit()
    assert label == "tester"

    expected = base64.b64encode(
        hmac.new(secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1).digest()
    ).decode("ascii")
    assert credential == expected
