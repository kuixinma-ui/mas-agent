import asyncio
from types import SimpleNamespace

import httpx
import pytest


@pytest.mark.parametrize('operation', ['stats', 'add', 'upload'])
@pytest.mark.parametrize('ready', [True, False])
def test_knowledge_api_uses_runtime_owned_knowledge(monkeypatch, operation, ready):
    from api import main

    class Knowledge:
        def __init__(self):
            self.documents = []

        async def doc_count_async(self):
            return 7 + len(self.documents)

        async def add_documents_async(self, documents):
            self.documents.extend(documents)
            return len(documents)

    knowledge = Knowledge()
    # Runtime registration wraps search in a function; it is not a bound method.
    tool = SimpleNamespace(handler=lambda params, context: None)
    monkeypatch.setattr(main, '_tool_manager', SimpleNamespace(_tools={'knowledge_search': tool}) if ready else None)
    monkeypatch.setattr(main, '_runtime', SimpleNamespace(knowledge=knowledge) if ready else None)

    async def exercise():
        transport = httpx.ASGITransport(app=main.app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
            if operation == 'stats':
                response = await client.get('/knowledge/stats')
            elif operation == 'add':
                response = await client.post('/knowledge/add', json={'documents': [{'title': 'Demo', 'content': 'Local test'}]})
            else:
                response = await client.post('/knowledge/upload', files={'file': ('demo.txt', b'Local test', 'text/plain')})
        assert response.status_code == (200 if ready else 503)
        if ready:
            assert response.json()['total_chunks'] == (7 if operation == 'stats' else 8)
            if operation != 'stats':
                assert knowledge.documents == [{'title': 'Demo' if operation == 'add' else 'demo', 'content': 'Local test'}]

    asyncio.run(exercise())
