"""HTTP/CLI execution parity without a provider, Redis or Chroma."""
import asyncio
from types import SimpleNamespace

import httpx
import pytest

from tests.test_scenarios import Runtime, dataset


@pytest.fixture
def execution_boundary(monkeypatch, tmp_path):
    import anthropic
    from api import main
    from evaluation import evaluator
    from evaluation import scenarios
    from observability.budgets import current_budget
    from services import runtime

    seen = SimpleNamespace(clients=[], runtimes=[], judges=[], budgets=[], runtime_error=None,
                           client_close_error=None, close_entered=None, close_release=None)
    # This suite verifies execution parity, not filesystem traversal. A frozen
    # source snapshot also keeps parallel implementation edits out of the test.
    monkeypatch.setattr(scenarios, '_tree_snapshot', lambda *a, **kw: {'offline.py': 'frozen-source'})

    class Client:
        def __init__(self, **kwargs):
            self.messages = SimpleNamespace(create=self.create)
            self.closed = False
            seen.clients.append(self)

        async def create(self, **kwargs):
            raise AssertionError('No model request is allowed')

        async def close(self):
            if seen.close_entered is not None:
                seen.close_entered.set()
                await seen.close_release.wait()
            self.closed = True
            if seen.client_close_error is not None:
                raise seen.client_close_error

    class FakeRuntime(Runtime):
        async def chat(self, *args, **kwargs):
            budget = current_budget()
            seen.budgets.append(None if budget is None else (budget.max_model_calls, budget.max_model_seconds))
            return await super().chat(*args, **kwargs)

    async def create_runtime(config, **kwargs):
        if seen.runtime_error:
            raise seen.runtime_error
        result = FakeRuntime()
        seen.runtimes.append(result)
        return result

    def judge(client, model, **options):
        seen.judges.append((model, options.get('mode', 'scores')))
        return SimpleNamespace()

    monkeypatch.setattr(anthropic, 'AsyncAnthropic', Client)
    monkeypatch.setattr(evaluator, 'LLMJudge', judge)
    monkeypatch.setattr(runtime, 'create_runtime', create_runtime)
    monkeypatch.setattr(runtime, 'runtime_config_from_env', lambda: {
        'api_key': 'offline-configured-key', 'model': 'chat-model',
        'judge_model': 'fixed-judge', 'judge_mode': 'scores'})
    monkeypatch.setattr(main, '_scenario_dataset', dataset)
    monkeypatch.setenv('ECHOMIND_EVAL_REPORT_DIR', str(tmp_path / 'api'))
    # The shared executor must use the same runtime configuration as the CLI.
    monkeypatch.setattr(main, '_anthropic_cfg', lambda: {'api_key': 'offline-configured-key', 'model': 'chat-model'})
    return seen


@pytest.mark.parametrize('limits', [{}, {'max_model_calls': 2, 'max_model_seconds': 15.0}])
def test_http_and_cli_share_budget_judge_and_cleanup(execution_boundary, tmp_path, limits):
    from api import main
    from evaluation.scenario_runner import _live

    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            response = await client.post('/eval/scenarios/run', json={'mode': 'live', **limits})
        assert response.status_code == 200
        api_report = response.json()
        cli_report = await _live(SimpleNamespace(judge=True, report_dir=tmp_path / 'cli', **limits), dataset())
        expected = (limits.get('max_model_calls', 200), limits.get('max_model_seconds', 1200))
        assert execution_boundary.budgets == [expected, expected]
        assert api_report['budget']['max_model_calls'] == cli_report['budget']['max_model_calls'] == expected[0]
        assert api_report['budget']['max_model_seconds'] == cli_report['budget']['max_model_seconds'] == expected[1]
        assert api_report['metadata']['fingerprints'] == cli_report['metadata']['fingerprints']
        assert api_report['passed'] == cli_report['passed'] == 1
        assert execution_boundary.judges == [('fixed-judge', 'scores')] * 2
        assert all(item.closed for item in execution_boundary.clients + execution_boundary.runtimes)
        assert len(list((tmp_path / 'api').glob('*.json'))) == len(list((tmp_path / 'cli').glob('*.json'))) == 1

    asyncio.run(exercise())


@pytest.mark.parametrize('limits', [
    {'max_model_calls': 0}, {'max_model_calls': True}, {'max_model_calls': 1.5},
    {'max_model_seconds': 0}, {'max_model_seconds': -1}, {'max_model_seconds': 'NaN'},
])
def test_http_rejects_invalid_budget_before_creating_resources(execution_boundary, limits):
    from api import main

    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            response = await client.post('/eval/scenarios/run', json={'mode': 'live', **limits})
        assert response.status_code == 422
        assert execution_boundary.clients == execution_boundary.runtimes == []

    asyncio.run(exercise())


def test_validate_never_constructs_model_or_runtime(execution_boundary):
    from api import main

    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            response = await client.post('/eval/scenarios/run')
        assert response.status_code == 200 and response.json()['status'] == 'validated'
        assert execution_boundary.clients == execution_boundary.runtimes == []

    asyncio.run(exercise())


def test_cli_uses_shared_default_limits_on_runtime_failure(execution_boundary, tmp_path):
    from evaluation.scenario_runner import _live
    execution_boundary.runtime_error = RuntimeError('offline initialization failed')
    report = asyncio.run(_live(SimpleNamespace(judge=True, report_dir=tmp_path), dataset()))
    assert report['status'] == 'error' and report['runtime_error']['type'] == 'RuntimeError'
    assert report['budget']['max_model_calls'] == 200
    assert report['budget']['max_model_seconds'] == 1200
    assert execution_boundary.clients[0].closed


def test_cli_closes_judge_client_when_saving_fails(execution_boundary, monkeypatch, tmp_path):
    from evaluation.report_store import ReportStore
    from evaluation.scenario_runner import _live

    def fail_save(self, report):
        raise OSError('offline disk failure')

    monkeypatch.setattr(ReportStore, 'save', fail_save)
    with pytest.raises(OSError, match='offline disk failure'):
        asyncio.run(_live(SimpleNamespace(judge=True, report_dir=tmp_path), dataset()))
    assert all(item.closed for item in execution_boundary.clients + execution_boundary.runtimes)


@pytest.mark.parametrize('close_fails', [False, True])
def test_judge_construction_failure_closes_client(execution_boundary, monkeypatch, tmp_path, close_fails):
    from evaluation import evaluator
    from evaluation.scenario_runner import _live

    def fail_judge(*args, **kwargs):
        raise RuntimeError('offline Judge construction failure')

    monkeypatch.setattr(evaluator, 'LLMJudge', fail_judge)
    if close_fails:
        execution_boundary.client_close_error = OSError('offline client close failure')
    with pytest.raises(RuntimeError, match='offline Judge construction failure'):
        asyncio.run(_live(SimpleNamespace(judge=True, report_dir=tmp_path), dataset()))
    assert len(execution_boundary.clients) == 1 and execution_boundary.clients[0].closed
    assert execution_boundary.runtimes == []


@pytest.mark.parametrize('close_fails', [False, True])
def test_cancellation_closes_resources_without_saving_a_completed_report(execution_boundary, monkeypatch, tmp_path, close_fails):
    from evaluation.scenario_runner import _live

    async def exercise():
        entered = asyncio.Event()
        if close_fails:
            execution_boundary.client_close_error = OSError('offline client close failure')

        async def waiting_chat(self, *args, **kwargs):
            entered.set()
            await asyncio.Future()

        monkeypatch.setattr(Runtime, 'chat', waiting_chat)
        task = asyncio.create_task(_live(SimpleNamespace(judge=True, report_dir=tmp_path), dataset()))
        await asyncio.wait_for(entered.wait(), 3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert all(item.closed for item in execution_boundary.clients + execution_boundary.runtimes)
        assert not list(tmp_path.glob('*.json'))

    asyncio.run(exercise())


def test_client_close_failure_is_recorded_before_report_is_saved(execution_boundary, tmp_path):
    from evaluation.report_store import ReportStore
    from evaluation.scenario_runner import _live
    execution_boundary.client_close_error = OSError('offline client close failure')
    report = asyncio.run(_live(SimpleNamespace(judge=True, report_dir=tmp_path), dataset()))
    assert report['status'] == report['cleanup']['status'] == 'error'
    assert report['cleanup']['phase'] == 'judge_client_close'
    assert report['cleanup']['runtime_cleanup']['status'] == 'completed'
    assert report['passed'] == 1 and report['pass_rate'] == 1
    assert ReportStore(tmp_path).load(report['run_id']) == report


def test_cancellation_during_client_close_waits_for_owned_cleanup(execution_boundary, tmp_path):
    from evaluation.scenario_runner import _live

    async def exercise():
        execution_boundary.close_entered = asyncio.Event()
        execution_boundary.close_release = asyncio.Event()
        task = asyncio.create_task(_live(SimpleNamespace(judge=True, report_dir=tmp_path), dataset()))
        await asyncio.wait_for(execution_boundary.close_entered.wait(), 3)
        try:
            task.cancel()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert not task.done(), 'Owned client cleanup must finish before cancellation escapes'
        finally:
            execution_boundary.close_release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert execution_boundary.clients[0].closed
        assert not list(tmp_path.glob('*.json'))

    asyncio.run(exercise())


@pytest.mark.parametrize('limits', [{'max_model_calls': 0}, {'max_model_calls': True}, {'max_model_seconds': float('nan')}])
def test_cli_rejects_invalid_budget_before_creating_resources(execution_boundary, tmp_path, limits):
    from evaluation.scenario_runner import _live
    with pytest.raises(ValueError):
        asyncio.run(_live(SimpleNamespace(judge=True, report_dir=tmp_path, **limits), dataset()))
    assert execution_boundary.clients == execution_boundary.runtimes == []


def test_history_preserves_run_failure_details_and_quality(tmp_path):
    from evaluation.report_store import ReportStore
    store = ReportStore(tmp_path)
    report = {'run_id': 'run_cleanup_failed', 'mode': 'live', 'status': 'error', 'total': 1, 'passed': 1, 'pass_rate': 1,
              'cleanup': {'status': 'error', 'type': 'OSError', 'message': 'cleanup unavailable'},
              'budget': {'stop_reason': 'deadline'}, 'runtime_error': {'type': 'RuntimeError', 'message': 'runtime failure'}}
    store.save(report)
    summary = store.list()[0]
    for field in ('status', 'cleanup', 'budget', 'runtime_error', 'passed', 'pass_rate'):
        assert summary[field] == report[field]
