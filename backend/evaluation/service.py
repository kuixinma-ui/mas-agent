"""Shared live evaluation execution for HTTP and CLI adapters."""
from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass

from observability.budgets import EvaluationBudget

DEFAULT_MAX_MODEL_CALLS = 200
DEFAULT_MAX_MODEL_SECONDS = 1200.0


class EvaluationConfigurationError(ValueError):
    """A live provider/Judge configuration is missing or unsupported."""


@dataclass(frozen=True)
class EvaluationOptions:
    judge_enabled: bool = False
    judge_mode: str | None = None
    max_model_calls: int = DEFAULT_MAX_MODEL_CALLS
    max_model_seconds: float = DEFAULT_MAX_MODEL_SECONDS


class EvaluationService:
    def __init__(self, report_store, *, telemetry=None):
        self.report_store = report_store
        self.telemetry = telemetry

    @staticmethod
    async def _close_client(client):
        if client is None:
            return
        closing = asyncio.create_task(client.close())
        cancellation = None
        while not closing.done():
            try:
                await asyncio.shield(closing)
            except asyncio.CancelledError as error:
                cancellation = cancellation or error
            except Exception:
                break
        if cancellation is not None:
            if not closing.cancelled():
                failure = closing.exception()
                if failure is not None:
                    cancellation.add_note(f'Judge client cleanup failed ({type(failure).__name__})')
            raise cancellation
        return closing.result()

    async def run_live(self, dataset, config, options: EvaluationOptions | None = None):
        # Validate controls before constructing any provider or runtime resource.
        options = options or EvaluationOptions()
        budget = EvaluationBudget(max_model_calls=options.max_model_calls,
                                  max_model_seconds=options.max_model_seconds)
        config = dict(config)
        key = config.get('api_key')
        if not key or key.strip().lower() in {'test', 'dummy', 'changeme', 'your-api-key'}:
            raise EvaluationConfigurationError('A configured ANTHROPIC_API_KEY is required for explicit live replay')
        config['judge_enabled'] = options.judge_enabled
        config['judge_mode'] = options.judge_mode or config.get('judge_mode', 'scores')
        if config['judge_mode'] not in ('scores', 'explained_v1'):
            raise EvaluationConfigurationError('Invalid Judge mode')

        from evaluation.scenario_runner import ScenarioRunner
        from evaluation.scenarios import build_fingerprints
        from observability.telemetry import get_telemetry
        from services.runtime import create_runtime

        metadata = {'mode': 'live', 'fingerprints': build_fingerprints(dataset, config)}
        client, judge = None, None
        try:
            if options.judge_enabled:
                from anthropic import AsyncAnthropic
                from evaluation.evaluator import LLMJudge
                from observability.instrumentation import AnthropicClientProxy
                client = AsyncAnthropic(api_key=key, **({'base_url': config['base_url']} if config.get('base_url') else {}))
                client = AnthropicClientProxy(client)
                judge_options = {'mode': config['judge_mode']} if config['judge_mode'] != 'scores' else {}
                judge = LLMJudge(client, config.get('judge_model') or config['model'], **judge_options)

            async def factory(**kwargs):
                runtime = create_runtime(config, **kwargs)
                return await runtime if inspect.isawaitable(runtime) else runtime

            runner = ScenarioRunner(factory, judge=judge, telemetry=self.telemetry or get_telemetry())
            report = await runner.run(dataset, metadata=metadata, budget=budget)
        except BaseException as error:
            try:
                await self._close_client(client)
            except asyncio.CancelledError:
                raise
            except Exception as cleanup_error:
                error.add_note(f'Judge client cleanup failed ({type(cleanup_error).__name__})')
            raise
        try:
            await self._close_client(client)
        except Exception as cleanup_error:
            report['status'] = 'error'
            report['cleanup'] = {'status': 'error', 'phase': 'judge_client_close',
                                 'type': type(cleanup_error).__name__, 'message': str(cleanup_error),
                                 'runtime_cleanup': report.get('cleanup')}
        await asyncio.to_thread(self.report_store.save, report)
        return report
