import importlib
import sys
from pathlib import Path

import pytest


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture()
def main_module(monkeypatch):
    monkeypatch.setenv("SERVER_IP", "127.0.0.1")
    monkeypatch.setenv("SERVER_DOMAIN", "localhost")
    monkeypatch.setenv("TURN_SECRET", "test-secret")
    monkeypatch.setenv("TURN_REALM", "localhost")
    monkeypatch.setenv("FRONTEND_ORIGIN", "http://localhost:5173")
    monkeypatch.setenv("MAX_SESSIONS", "10")
    monkeypatch.setenv("SESSIONS_RATE_LIMIT", "1000/minute")
    monkeypatch.setenv("TURN_CRED_TTL", "3600")

    sys.modules.pop("main", None)
    return importlib.import_module("main")
