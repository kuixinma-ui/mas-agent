"""Cache identity follows the complete, normalized classifier input offline."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from core.intent_recognizer import IntentCategory, IntentRecognizer


def offline_recognizer():
    """Keep prompt construction, parsing and fusion; replace provider boundaries."""
    requests = []

    async def create(**kwargs):
        requests.append(kwargs)
        text = kwargs["messages"][0]["content"]
        payload = {
            "intent": "feedback" if "标记乙" in text else "query",
            "confidence": 1.0,
            "knowledge_required": False,
            "reasoning": "offline classification",
        }
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(
            type="text", text=json.dumps(payload),
        )])

    async def embed(**kwargs):
        # No embedding signal competes with the controlled classification.
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.0, 0.0])])

    recognizer = IntentRecognizer.__new__(IntentRecognizer)
    recognizer.client = SimpleNamespace(
        messages=SimpleNamespace(create=create),
        embeddings=SimpleNamespace(create=embed),
    )
    recognizer.model = "offline-model"
    recognizer.threshold = 0.5
    recognizer._embedding_enabled = True
    recognizer._tpl_embeddings = {}
    recognizer._cache = {}
    recognizer.cache_hits = recognizer.cache_misses = 0
    return recognizer, requests


LONG_INPUT_PAIRS = [
    pytest.param(
        {"message": "述" * 200 + "标记甲"},
        {"message": "述" * 200 + "标记乙"},
        id="current-message-after-200",
    ),
    pytest.param(
        {"message": "继续", "history": [{"role": "user", "content": "述" * 160 + "标记甲"}]},
        {"message": "继续", "history": [{"role": "user", "content": "述" * 160 + "标记乙"}]},
        id="history-content-after-160",
    ),
    pytest.param(
        {"message": "继续", "history": [{"role": "r" * 20 + "标记甲", "content": "背景"}]},
        {"message": "继续", "history": [{"role": "r" * 20 + "标记乙", "content": "背景"}]},
        id="history-role-after-20",
    ),
]


@pytest.mark.parametrize("first_input,second_input", LONG_INPUT_PAIRS)
def test_visible_tail_changes_have_distinct_cache_keys(first_input, second_input):
    recognizer = IntentRecognizer.__new__(IntentRecognizer)
    assert recognizer._cache_key(**first_input) != recognizer._cache_key(**second_input)


@pytest.mark.parametrize("first_input,second_input", LONG_INPUT_PAIRS)
def test_recognize_does_not_reuse_a_result_for_a_different_visible_tail(first_input, second_input):
    recognizer, requests = offline_recognizer()

    async def run():
        first = await recognizer.recognize(**first_input)
        second = await recognizer.recognize(**second_input)
        repeated = await recognizer.recognize(**second_input)
        assert first.intent is IntentCategory.QUERY
        assert second.intent is IntentCategory.FEEDBACK
        assert repeated is second

    asyncio.run(run())
    assert len(requests) == 2
    assert "标记甲" in requests[0]["messages"][0]["content"]
    assert "标记乙" in requests[1]["messages"][0]["content"]
    assert recognizer.cache_stats == {"size": 2, "hits": 1, "misses": 2, "hit_rate": 1 / 3}


def test_unicode_cleaning_equivalent_inputs_reuse_the_cached_result():
    recognizer, requests = offline_recognizer()

    async def run():
        first = await recognizer.recognize("继\ud800续", history=[
            {"role": "us\udfff er", "content": "背\ud800景"},
        ])
        second = await recognizer.recognize("继续", history=[
            {"role": "us er", "content": "背景"},
        ])
        assert second is first

    asyncio.run(run())
    assert len(requests) == 1
    assert "  us er: 背景" in requests[0]["messages"][0]["content"]
    assert recognizer.cache_hits == 1


def test_missing_history_role_reuses_the_explicit_user_role_result():
    recognizer, requests = offline_recognizer()

    async def run():
        first = await recognizer.recognize("继续", history=[{"content": "背景"}])
        second = await recognizer.recognize("继续", history=[{"role": "user", "content": "背景"}])
        assert second is first

    asyncio.run(run())
    assert len(requests) == 1
    assert "  user: 背景" in requests[0]["messages"][0]["content"]
    assert recognizer.cache_hits == 1


def test_history_outside_the_three_visible_messages_does_not_split_cache():
    recognizer, requests = offline_recognizer()
    recent = [{"role": "user", "content": "背景"} for _ in range(3)]

    async def run():
        first = await recognizer.recognize("继续", history=[{"role": "user", "content": "标记甲"}, *recent])
        second = await recognizer.recognize("继续", history=[{"role": "user", "content": "标记乙"}, *recent])
        assert second is first

    asyncio.run(run())
    assert len(requests) == 1
    assert "标记甲" not in requests[0]["messages"][0]["content"]
    assert "标记乙" not in requests[0]["messages"][0]["content"]


def archived(content):
    return {"role": "user", "content": content, "source_conv": "prior",
            "evidence_id": "mem_" + "a" * 64}


def test_visible_archive_change_does_not_reuse_a_previous_result():
    recognizer, requests = offline_recognizer()

    async def run():
        first = await recognizer.recognize("继续", archived_user_messages=[archived("标记甲")])
        second = await recognizer.recognize("继续", archived_user_messages=[archived("标记乙")])
        assert first.intent is IntentCategory.QUERY
        assert second.intent is IntentCategory.FEEDBACK

    asyncio.run(run())
    assert len(requests) == 2
    assert recognizer.cache_misses == 2


def test_archive_normalization_equivalent_inputs_reuse_the_cached_result():
    recognizer, requests = offline_recognizer()
    first_archive = archived("述" * 500 + "标记甲")
    second_archive = archived("述" * 500 + "标记乙")

    async def run():
        first = await recognizer.recognize("继续", archived_user_messages=[first_archive])
        second = await recognizer.recognize("继续", archived_user_messages=[
            {**second_archive, "role": "assistant"}, second_archive, dict(second_archive),
        ])
        assert second is first

    asyncio.run(run())
    assert len(requests) == 1
    text = requests[0]["messages"][0]["content"]
    assert "归档用户陈述" in text
    assert "标记甲" not in text and "标记乙" not in text
    assert recognizer.cache_hits == 1


def test_invalid_archive_reuses_the_input_without_archive():
    recognizer, requests = offline_recognizer()

    async def run():
        first = await recognizer.recognize("继续")
        second = await recognizer.recognize("继续", archived_user_messages="标记乙")
        assert second is first

    asyncio.run(run())
    assert len(requests) == 1
    assert "归档用户陈述" not in requests[0]["messages"][0]["content"]
