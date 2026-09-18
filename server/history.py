"""Bounded in-memory conversation history, scoped per userId. Phase 3 needs
"last 3 exchanges" as reconstruction context (RELAY_PLAYBOOK.md §4) — this
is the smallest reliable mechanism for that, not a database. Not persisted;
lost on server restart. Phase 5+ may replace this with real storage."""

from collections import defaultdict, deque

MAX_HISTORY = 3

_history: dict[str, deque[str]] = defaultdict(lambda: deque(maxlen=MAX_HISTORY))


def get_history(user_id: str) -> list[str]:
    """Last <=3 exchanges for this user, oldest first."""
    return list(_history[user_id])


def append_exchange(user_id: str, transcript: str) -> None:
    """Record this turn's transcript as the newest exchange, evicting the
    oldest once more than MAX_HISTORY have accumulated."""
    _history[user_id].append(transcript)
