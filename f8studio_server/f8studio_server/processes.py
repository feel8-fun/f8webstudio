"""Studio presentation of service processes owned by the independent platform."""
from __future__ import annotations

import asyncio
import logging

import msgspec

from f8pysdk.platform_client import PlatformClient
from f8pysdk.platform_errors import ServiceUnavailableError
from f8pysdk.platform_spec import ServiceStartRequest as PlatformServiceStart

from .events import EventJournal
from .runtime import RuntimeConfig

logger = logging.getLogger(__name__)


class ManagedProcessResult(msgspec.Struct, frozen=True, kw_only=True, rename='camel'):
    service_id: str
    running: bool


class ManagedServiceProcesses:
    def __init__(self, *, runtime_config: RuntimeConfig, events: EventJournal, platform: PlatformClient) -> None:
        self._platform = platform
        self._runtime_config = runtime_config
        self._events = events
        self._observed: set[str] = set()
        self._log_task: asyncio.Task[None] | None = None
        self._log_sequence = 0

    def is_class_running(self, service_class: str) -> bool:
        return any(item.service_class == service_class and item.running for item in self._platform.services())

    def can_start(self, service_class: str) -> bool:
        return service_class in self._platform.inventory().service_classes

    async def start(self, service_id: str, *, service_class: str) -> ManagedProcessResult:
        config = self._runtime_config
        status = await self._platform.start_service(service_id, PlatformServiceStart(
            service_class=service_class, bus_backend=config.bus_backend, zenoh_config_path=config.zenoh_config_path,
            zenoh_connect=config.zenoh_connect, zenoh_listen=config.zenoh_listen,
            zenoh_shm_pool_bytes=config.zenoh_shm_pool_bytes))
        self._observed.add(service_id)
        if self._log_task is None:
            self._log_task = asyncio.create_task(self._collect_logs())
        await self._events.publish(event_type='service.process_started', scope=f'service:{service_id}',
            payload={'serviceId':service_id,'serviceClass':service_class,'running':status.running})
        return ManagedProcessResult(service_id=service_id, running=status.running)

    async def stop(self, service_id: str) -> ManagedProcessResult:
        status = await self._platform.stop_service(service_id)
        self._observed.discard(service_id)
        await self._events.publish(event_type='service.process_stopped', scope=f'service:{service_id}',
            payload={'serviceId':service_id,'running':status.running})
        return ManagedProcessResult(service_id=service_id, running=status.running)

    def is_running(self, service_id: str) -> bool:
        return any(item.service_id == service_id and item.running for item in self._platform.services())

    async def _collect_logs(self) -> None:
        unavailable = False
        while True:
            try:
                records = await asyncio.to_thread(self._platform.logs, self._log_sequence)
                unavailable = False
                for record in records:
                    self._log_sequence = record.sequence
                    if record.service_id in self._observed:
                        await self._events.publish(event_type='service.log', scope=f'service:{record.service_id}',
                            payload={'serviceId':record.service_id,'line':record.line})
            except ServiceUnavailableError:
                if not unavailable:
                    logger.exception('Platform is unavailable while collecting service logs')
                    unavailable = True
            await asyncio.sleep(0.5)

    async def close(self) -> None:
        # Disconnecting an editor does not shut down platform-owned processes.
        if self._log_task is not None:
            self._log_task.cancel()
            results = await asyncio.gather(self._log_task, return_exceptions=True)
            for result in results:
                if isinstance(result, Exception):
                    logger.error('Platform log collection failed', exc_info=result)
        self._observed.clear()


__all__ = ['ManagedProcessResult', 'ManagedServiceProcesses']
