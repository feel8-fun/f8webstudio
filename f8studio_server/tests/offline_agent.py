"""Offline graph workflow provider for tests only."""
from f8studio_server.agents.models import AgentProviderSummary
from f8studio_server.agents.providers import AgentProviderRegistry


class OfflineAgentProvider(AgentProviderRegistry):
    def summaries(self) -> tuple[AgentProviderSummary, ...]:
        return (AgentProviderSummary(
            provider_id="deterministic", display_name="Offline test graph agent",
            models=("graph-builder-v1",), configured=True, deterministic=True,
        ), *super().summaries())
