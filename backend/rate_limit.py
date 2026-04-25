"""
Token bucket для лимита WS-сообщений на клиента.

Ёмкость = burst-окно. Скорость пополнения = средний RPS.
Один зловредный клиент не сможет завалить пира спамом.
"""

import time


class TokenBucket:
    """Простой in-memory token bucket. Не потокобезопасен — рассчитан на использование внутри одного asyncio-таска."""

    __slots__ = ("capacity", "refill_rate", "_tokens", "_last_refill")

    def __init__(self, capacity: int, refill_rate: float) -> None:
        """
        capacity: максимум токенов (короткий burst).
        refill_rate: токенов в секунду (стабильный RPS).
        """
        self.capacity = capacity
        self.refill_rate = refill_rate
        self._tokens: float = float(capacity)
        self._last_refill = time.monotonic()

    def try_consume(self, tokens: int = 1) -> bool:
        """Возвращает True если токены списались, False если лимит превышен."""
        now = time.monotonic()
        elapsed = now - self._last_refill
        if elapsed > 0:
            self._tokens = min(
                float(self.capacity),
                self._tokens + elapsed * self.refill_rate,
            )
            self._last_refill = now

        if self._tokens >= tokens:
            self._tokens -= tokens
            return True
        return False
