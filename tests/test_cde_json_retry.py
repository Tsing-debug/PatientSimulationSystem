import asyncio
from unittest.mock import AsyncMock

import pytest
from service.agent.cde_extract import CdeExtractAgent


def test_invalid_json_is_regenerated_from_original_source(monkeypatch):
    agent = CdeExtractAgent()
    chat = AsyncMock(side_effect=[('{"cde": {} "suggest": {}}', {}), ('{"cde": {}, "suggest": {}}', {})])
    monkeypatch.setattr(agent, '_chat', chat)
    result = asyncio.run(agent.extract('original trial source'))
    assert isinstance(result['cde'], dict)
    assert chat.await_count == 2
    assert 'original trial source' in chat.call_args.args[0][1]['content']


def test_persistent_invalid_output_fails_after_bounded_retries(monkeypatch):
    agent = CdeExtractAgent()
    chat = AsyncMock(return_value=('{}', {}))
    monkeypatch.setattr(agent, '_chat', chat)
    with pytest.raises(RuntimeError, match='已自动重试 3 次'):
        asyncio.run(agent.extract('original trial source'))
    assert chat.await_count == 4


def test_third_retry_can_succeed(monkeypatch):
    agent = CdeExtractAgent()
    chat = AsyncMock(side_effect=[('{}', {})] * 3 + [('{"cde": {}, "suggest": {}}', {})])
    monkeypatch.setattr(agent, '_chat', chat)
    assert isinstance(asyncio.run(agent.extract('trial source'))['cde'], dict)
    assert chat.await_count == 4
