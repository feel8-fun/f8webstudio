"""Studio API: agents."""
from __future__ import annotations

import asyncio
import logging
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from f8pysdk.specs import F8JsonValue
from f8pysdk.decision import DecisionRequest, validate_questions
from ..application import StudioApplication
from ..agents import CreateAgentSessionRequest, ResolveAgentApprovalRequest, RenameAgentSessionRequest, SelectAgentModelRequest, StartAgentRunRequest
from ..agents.provider_settings import CreateProviderConnection, UpdateProviderSettings
from ..agents.provider_probe import ProbeProviderRequest
from ..agents.decisions import DecisionCapacityError, DecisionResponseError
from ..http_support import json_value, decode_body

logger = logging.getLogger(__name__)

def install_agents_routes(app: FastAPI, studio: StudioApplication) -> None:
    @app.get("/api/agents/providers")
    async def agent_providers() -> F8JsonValue:
        return json_value(studio.agents.providers())


    @app.get("/api/agents/providers/settings")
    async def agent_provider_settings() -> F8JsonValue:
        return json_value(studio.agents.provider_settings())


    @app.post("/api/decisions/evaluate")
    async def evaluate_decisions(request: Request) -> F8JsonValue:
        payload = await decode_body(request, DecisionRequest)
        validate_questions(payload.questions)
        try:
            return json_value(await studio.decisions.evaluate(payload))
        except DecisionCapacityError as exc:
            raise HTTPException(status_code=429, detail=str(exc), headers={"Retry-After": "1"}) from exc
        except DecisionResponseError as exc:
            studio.decisions.report_failure("Invalid TypeSafe decision response", exc)
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except httpx.HTTPStatusError as exc:
            studio.decisions.report_failure(f"TypeSafe decision request failed: HTTP {exc.response.status_code}", exc)
            if exc.response.status_code in {429, 529}:
                raise HTTPException(status_code=429, detail="TypeSafe is rate limited or overloaded; reduce query frequency", headers={"Retry-After": "2"}) from exc
            raise HTTPException(status_code=502, detail=f"TypeSafe returned HTTP {exc.response.status_code}; check provider settings") from exc
        except httpx.TimeoutException as exc:
            studio.decisions.report_failure("TypeSafe decision request timed out", exc)
            raise HTTPException(status_code=504, detail="TypeSafe decision request timed out") from exc
        except httpx.RequestError as exc:
            studio.decisions.report_failure("TypeSafe decision connection failed", exc)
            raise HTTPException(status_code=502, detail="Could not connect to TypeSafe") from exc


    @app.put("/api/agents/providers/{provider_id}/settings")
    async def update_agent_provider_settings(provider_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, UpdateProviderSettings)
        return json_value(await studio.agents.update_provider_settings(provider_id, payload))


    @app.post("/api/agents/connections", status_code=201)
    async def create_agent_connection(request: Request) -> F8JsonValue:
        payload = await decode_body(request, CreateProviderConnection)
        return json_value(await studio.agents.create_provider_connection(payload))


    @app.delete("/api/agents/connections/{provider_id}", status_code=204)
    async def delete_agent_connection(provider_id: str) -> Response:
        await studio.agents.delete_provider_connection(provider_id)
        return Response(status_code=204)


    @app.post("/api/agents/connections/probe")
    async def probe_agent_connection(request: Request) -> F8JsonValue:
        payload = await decode_body(request, ProbeProviderRequest)
        return json_value(await studio.agents.probe_provider(payload))


    @app.get("/api/agents/sessions")
    async def agent_sessions(project_id: str | None = None) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.agents.list, project_id))


    @app.post("/api/agents/sessions", status_code=201)
    async def create_agent_session(request: Request) -> F8JsonValue:
        payload = await decode_body(request, CreateAgentSessionRequest)
        return json_value(await asyncio.to_thread(studio.agents.create, payload))


    @app.get("/api/agents/sessions/{session_id}")
    async def get_agent_session(session_id: str) -> F8JsonValue:
        return json_value(await asyncio.to_thread(studio.agents.get, session_id))


    @app.put("/api/agents/sessions/{session_id}")
    async def rename_agent_session(session_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, RenameAgentSessionRequest)
        return json_value(await studio.agents.rename(session_id, payload))


    @app.delete("/api/agents/sessions/{session_id}", status_code=204)
    async def delete_agent_session(session_id: str) -> Response:
        await studio.agents.delete(session_id)
        return Response(status_code=204)


    @app.put("/api/agents/sessions/{session_id}/model")
    async def select_agent_model(session_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, SelectAgentModelRequest)
        return json_value(await studio.agents.select_model(session_id, payload))


    @app.post("/api/agents/sessions/{session_id}/runs", status_code=202)
    async def start_agent_run(session_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, StartAgentRunRequest)
        return json_value(await studio.agents.start_run(session_id, payload))


    @app.post("/api/agents/sessions/{session_id}/approvals/{approval_id}")
    async def resolve_agent_approval(session_id: str, approval_id: str, request: Request) -> F8JsonValue:
        payload = await decode_body(request, ResolveAgentApprovalRequest)
        return json_value(await studio.agents.resolve_approval(session_id, approval_id, payload))


    @app.delete("/api/agents/sessions/{session_id}/runs/current")
    async def cancel_agent_run(session_id: str) -> F8JsonValue:
        return json_value(await studio.agents.cancel(session_id))

