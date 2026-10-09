from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
import msgspec
import pytest

from f8studio_core.graph import CreateNodeOp, HistoryRequest, NodeCatalog, NodeLayout, OperatorNode, PatchRequest, RevisionConflictError, SetNodeLayoutOp, SetNodeStateOp
from f8studio_core.graph.state_policy import normalize_node_policy
from f8studio_core.publication import decode_component
from f8studio_server.assets import AssetKind, CaptureComponentRequest, CreateAssetRequest, UpdateAssetRequest, VariantContent
from f8studio_server.component_models import InsertComponentRequest
from f8studio_server.errors import InvalidRequestError
from f8studio_server.variant_models import CaptureVariantRequest
from f8studio_server.variants import variant_node
from f8studio_server.application import StudioApplication
from f8studio_server.models import CreateCatalogNodeRequest, CreateProjectRequest
from f8pysdk.specs import F8StateAccess, F8StateSpec, string_schema
from f8pysdk.specs import F8JsonValue
from f8pyengine.operators.tick import TickRuntimeNode
from f8pyengine.operators.fbx_skeleton_player import FbxSkeletonPlayerRuntimeNode
from f8studio_server.variants import capture_variant
from test_components import SOURCE_CODE, studio_with_template


def capture_request(**changes: object) -> CaptureVariantRequest:
    request = CaptureVariantRequest(node_id="script", name="Smooth Variant", description="Customized script", tags=("signal",),
        expected_graph_revision=1, expected_layout_revision=1)
    return msgspec.structs.replace(request, **changes)


@pytest.mark.parametrize("values", [{}, {"tickMs": 250, "hiResTimer": False}])
def test_tick_configuration_keeps_defaults_or_saved_overrides_through_variant_insertion(tmp_path: Path, values: dict[str, F8JsonValue]) -> None:
    studio, _ = studio_with_template(tmp_path)
    studio.catalog.sdk_catalog.register_operators([TickRuntimeNode.SPEC])
    tick = NodeCatalog(operators=[TickRuntimeNode.SPEC]).create_operator_node(node_id="tick", service_id="source_engine",
        service_class="f8.pyengine", operator_class=TickRuntimeNode.SPEC.operatorClass, state_values=values)
    studio.projects.patch("source", PatchRequest(request_id="add_tick", expected_graph_revision=1, expected_layout_revision=1,
        operations=(CreateNodeOp(node=tick),)))
    asset = studio.tools.capture_variant("source", capture_request(node_id="tick", expected_graph_revision=2))
    result = asyncio.run(studio.tools.insert_component("target", InsertComponentRequest(request_id="tick_variant",
        asset_id=asset.asset_id, version=1, expected_graph_revision=1, expected_layout_revision=0,
        host_bindings={"host": "existing_engine"})))
    copy = result.patch.document.nodes[-1]
    assert copy.state_values == values
    fields = {field.name: field for field in copy.spec.stateFields}
    assert fields["tickMs"].persistent is True and fields["tickMs"].publishable is True
    assert fields["hiResTimer"].persistent is True and fields["hiResTimer"].publishable is True
    assert fields["tickMs"].valueSchema.default == 100
    assert fields["hiResTimer"].valueSchema.default is True
    restarted = StudioApplication(data_dir=tmp_path / "studio", service_roots=())
    assert restarted.projects.document("target").nodes[-1] == copy


def test_fbx_file_and_executable_paths_stay_local_while_loop_setting_is_published(tmp_path: Path) -> None:
    studio, _ = studio_with_template(tmp_path)
    studio.catalog.sdk_catalog.register_operators([FbxSkeletonPlayerRuntimeNode.SPEC])
    player = NodeCatalog(operators=[FbxSkeletonPlayerRuntimeNode.SPEC]).create_operator_node(node_id="fbx", service_id="source_engine",
        service_class="f8.pyengine", operator_class=FbxSkeletonPlayerRuntimeNode.SPEC.operatorClass,
        state_values={"path": "/private/animation.fbx", "blenderPath": "/local/blender", "loop": False})
    studio.projects.patch("source", PatchRequest(request_id="add_fbx", expected_graph_revision=1, expected_layout_revision=1,
        operations=(CreateNodeOp(node=player),)))
    asset = studio.tools.capture_variant("source", capture_request(node_id="fbx", expected_graph_revision=2))
    template = variant_node(decode_component(msgspec.json.encode(asset.content)))
    assert template.state_values == {"loop": False}
    assert b"/private/animation.fbx" not in msgspec.json.encode(asset.content)
    assert b"/local/blender" not in msgspec.json.encode(asset.content)
    restarted = StudioApplication(data_dir=tmp_path / "studio", service_roots=())
    assert restarted.projects.document("source").nodes[-1].state_values == player.state_values


def test_deep_custom_operator_roundtrip_records_sources_and_fixes_instance_version(tmp_path: Path) -> None:
    studio, _ = studio_with_template(tmp_path)
    source_before = studio.projects.document("source")
    asset = studio.tools.capture_variant("source", capture_request())
    assert asset.kind is AssetKind.variant
    template = decode_component(msgspec.json.encode(asset.content))
    assert template.presentation.node_order == ("template",)
    assert list(template.operators) == ["template"]
    assert template.services == {}
    assert template.host_bindings[0].binding_id == "host"
    node = variant_node(template)
    assert isinstance(node, OperatorNode)
    assert node.spec == source_before.nodes[1].spec
    assert node.state_values["code"] == SOURCE_CODE
    assert node.state_values["alpha"] == 0.25
    assert studio.projects.document("source") == source_before
    assert studio.projects.variant_sources("source")[0].version == 1
    catalog = studio.assets.variant_catalog()
    assert catalog[0].operator_class == node.operator_class
    request = InsertComponentRequest(request_id="add_variant", asset_id=asset.asset_id, version=1,
        expected_graph_revision=1, expected_layout_revision=0, host_bindings={"host": "existing_engine"}, x=150, y=200)
    inserted = asyncio.run(studio.tools.insert_component("target", request))
    copy = inserted.patch.document.nodes[-1]
    assert copy.name == asset.name
    assert copy.node_id != "script"
    assert copy.service_id == "existing_engine"
    assert copy.spec == node.spec
    assert copy.state_values["code"] == SOURCE_CODE
    assert studio.projects.variant_sources("target")[0].node_id == copy.node_id
    assert studio.projects.variant_sources("target")[0].version == 1
    change = PatchRequest(request_id="change_alpha", expected_graph_revision=1, expected_layout_revision=1,
        operations=(SetNodeStateOp(node_id="script", field="alpha", value=0.8),))
    asyncio.run(studio.tools.apply_patch("source", change))
    updated = studio.tools.capture_variant("source", capture_request(asset_id=asset.asset_id, expected_version=1, expected_graph_revision=2))
    assert updated.current_version == 2
    assert studio.projects.document("target") == inserted.patch.document
    assert studio.projects.variant_sources("target")[0].version == 1
    restarted = StudioApplication(data_dir=tmp_path / "studio", service_roots=())
    assert restarted.projects.variant_sources("target")[0].version == 1
    assert restarted.projects.variant_sources("source")[0].version == 2
    old_template = variant_node(decode_component(msgspec.json.encode(studio.assets.version(asset.asset_id, 1).content)))
    assert old_template.state_values["alpha"] == 0.25
    assert variant_node(decode_component(msgspec.json.encode(updated.content))).state_values["alpha"] == 0.8
    with pytest.raises(RevisionConflictError, match="asset changed"):
        studio.tools.capture_variant("source", capture_request(asset_id=asset.asset_id, expected_version=1, expected_graph_revision=2))
    assert studio.assets.get(asset.asset_id).current_version == 2


def test_movement_metadata_and_unchanged_saves_do_not_create_template_versions(tmp_path: Path) -> None:
    studio, _ = studio_with_template(tmp_path)
    asset = studio.tools.capture_variant("source", capture_request())
    studio.projects.patch("source", PatchRequest(request_id="move", expected_graph_revision=1, expected_layout_revision=1,
        operations=(SetNodeLayoutOp(layout=NodeLayout(node_id="script", x=600, y=800)),)))
    saved = studio.tools.capture_variant("source", capture_request(asset_id=asset.asset_id, expected_version=1,
        expected_layout_revision=2, name="Better name", tags=("signal", "reusable")))
    assert saved.content == asset.content
    assert saved.current_version == 1
    assert saved.name == "Better name"
    assert len(studio.assets.versions(asset.asset_id)) == 1


def test_variant_source_returns_with_instance_after_undo_redo(tmp_path: Path) -> None:
    studio, _ = studio_with_template(tmp_path)
    asset = studio.tools.capture_variant("source", capture_request())
    inserted = asyncio.run(studio.tools.insert_component("target", InsertComponentRequest(request_id="add_history",
        asset_id=asset.asset_id, version=1, expected_graph_revision=1, expected_layout_revision=0,
        host_bindings={"host": "existing_engine"})))
    sources = studio.projects.variant_sources("target")
    assert len(sources) == 1
    document = inserted.patch.document
    undone = studio.projects.undo("target", HistoryRequest(request_id="undo_variant",
        expected_graph_revision=document.graph_revision, expected_layout_revision=document.layout_revision))
    assert not studio.projects.variant_sources("target")
    document = undone.result.document
    studio.projects.redo("target", HistoryRequest(request_id="redo_variant",
        expected_graph_revision=document.graph_revision, expected_layout_revision=document.layout_revision))
    assert studio.projects.variant_sources("target") == sources


def test_service_variant_captures_only_the_service_and_creates_a_distinct_service(tmp_path: Path) -> None:
    studio, _ = studio_with_template(tmp_path)
    saved = studio.tools.capture_variant("source", capture_request(node_id="source_engine", name="Engine preset"))
    template = decode_component(msgspec.json.encode(saved.content))
    assert list(template.services) == ["template"]
    assert not template.operators and not template.host_bindings
    result = asyncio.run(studio.tools.insert_component("target", InsertComponentRequest(request_id="service_variant",
        asset_id=saved.asset_id, version=1, expected_graph_revision=1, expected_layout_revision=0)))
    assert len(result.patch.document.nodes) == 2
    assert result.patch.document.nodes[-1].node_id != "existing_engine"
    assert result.patch.document.nodes[-1].name == "Engine preset"


def test_legacy_variants_are_presets_with_versions_and_export_import_preserved(tmp_path: Path) -> None:
    studio, _ = studio_with_template(tmp_path)
    legacy = studio.assets.create(CreateAssetRequest(kind=AssetKind.variant, name="Old settings",
        content=msgspec.to_builtins(VariantContent(service_class="f8.pyengine"))))
    assert legacy.kind is AssetKind.preset
    with studio.database.connection() as connection:
        connection.execute("UPDATE local_assets SET kind = 'variant' WHERE asset_id = ?", (legacy.asset_id,))
    restarted = StudioApplication(data_dir=tmp_path / "studio", service_roots=())
    assert restarted.assets.get(legacy.asset_id).kind is AssetKind.preset
    assert restarted.assets.get(legacy.asset_id).current_version == 1
    assert not restarted.assets.variant_catalog()
    exported = restarted.assets.export(legacy.asset_id)
    imported = studio.assets.import_asset(msgspec.structs.replace(exported,
        asset=msgspec.structs.replace(exported.asset, asset_id="imported", kind=AssetKind.variant),
        versions=tuple(msgspec.structs.replace(version, asset_id="imported") for version in exported.versions)))
    assert imported.kind is AssetKind.preset


def test_variant_updates_require_matching_class_and_one_node(tmp_path: Path) -> None:
    studio, _ = studio_with_template(tmp_path)
    asset = studio.tools.capture_variant("source", capture_request())
    with pytest.raises(InvalidRequestError, match="class cannot change"):
        studio.tools.capture_variant("source", capture_request(node_id="source_engine", asset_id=asset.asset_id, expected_version=1))
    with pytest.raises(InvalidRequestError, match="expectedVersion"):
        studio.assets.update(asset.asset_id, UpdateAssetRequest(name=asset.name, content=asset.content))
    component = studio.tools.capture_component("source", CaptureComponentRequest(
        name="Pair", node_ids=("source_engine", "script"), expected_graph_revision=1, expected_layout_revision=1))
    with pytest.raises(InvalidRequestError, match="exactly one"):
        studio.assets.create(CreateAssetRequest(kind=AssetKind.variant, name="Invalid", content=component.content))


def test_saved_values_are_cleaned_but_definition_defaults_remain(tmp_path: Path) -> None:
    studio, _ = studio_with_template(tmp_path)
    document = studio.projects.document("source")
    node = document.nodes[1]
    assert isinstance(node, OperatorNode)
    fields = [
        F8StateSpec(name="private_path", access=F8StateAccess.rw, persistent=True, publishable=False,
            valueSchema=string_schema(default="example-path")),
        F8StateSpec(name="session_value", access=F8StateAccess.rw, persistent=False, publishable=False,
            valueSchema=string_schema(default="example-session")),
        F8StateSpec(name="status", access=F8StateAccess.ro, persistent=False, publishable=False,
            valueSchema=string_schema(default="example-status")),
    ]
    modified = msgspec.structs.replace(node, spec=msgspec.structs.replace(node.spec, stateFields=[*node.spec.stateFields, *fields]),
        state_values={**node.state_values, "private_path": "/private/real", "session_value": "real-session", "status": "running"})
    document = msgspec.structs.replace(document, nodes=(document.nodes[0], modified))
    modified = normalize_node_policy(modified)
    document = msgspec.structs.replace(document, nodes=(document.nodes[0], modified))
    template = capture_variant(document, "script", ())
    cleaned = variant_node(template)
    assert "private_path" not in cleaned.state_values
    assert "session_value" not in cleaned.state_values
    assert "status" not in cleaned.state_values
    assert next(field for field in cleaned.spec.stateFields if field.name == "private_path").valueSchema.default == "example-path"


def test_source_write_failure_rolls_back_asset_and_graph_insertion(tmp_path: Path) -> None:
    studio, _ = studio_with_template(tmp_path)
    asset = studio.tools.capture_variant("source", capture_request())
    before = studio.projects.document("target")
    with studio.database.connection() as connection:
        connection.execute("""CREATE TRIGGER reject_variant_source BEFORE INSERT ON node_variants
            BEGIN SELECT RAISE(ABORT, 'simulated Variant source failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="Variant source failure"):
        studio.tools.capture_variant("source", capture_request(name="Another template"))
    assert len(studio.assets.list_assets(AssetKind.variant)) == 1
    with pytest.raises(sqlite3.IntegrityError, match="Variant source failure"):
        asyncio.run(studio.tools.insert_component("target", InsertComponentRequest(request_id="rollback", asset_id=asset.asset_id,
            version=1, expected_graph_revision=1, expected_layout_revision=0, host_bindings={"host": "existing_engine"})))
    assert studio.projects.document("target") == before
    assert not studio.projects.variant_sources("target")


def test_builtin_operator_variant_creates_only_one_studio_host(tmp_path: Path) -> None:
    studio = StudioApplication(data_dir=tmp_path / "builtin", service_roots=())
    host = studio.catalog.create_node(CreateCatalogNodeRequest(kind="service", node_id="studio", service_class="f8.pystudio"))
    note = studio.catalog.create_node(CreateCatalogNodeRequest(kind="operator", node_id="note", service_id="studio",
        service_class="f8.pystudio", operator_class="f8.note"))
    studio.projects.create(CreateProjectRequest(project_id="source", name="Notes"))
    studio.projects.patch("source", PatchRequest(request_id="create", expected_graph_revision=0, expected_layout_revision=0,
        operations=(CreateNodeOp(node=host), CreateNodeOp(node=note))))
    asset = studio.tools.capture_variant("source", capture_request(node_id="note", expected_layout_revision=0))
    studio.projects.create(CreateProjectRequest(project_id="empty", name="Empty"))
    request = InsertComponentRequest(request_id="first_note", expected_graph_revision=0, expected_layout_revision=0,
        asset_id=asset.asset_id, version=1, host_bindings={"host": "studio"})
    inserted = asyncio.run(studio.tools.insert_component("empty", request))
    second = asyncio.run(studio.tools.insert_component("empty", msgspec.structs.replace(request, request_id="second_note",
        expected_graph_revision=1, expected_layout_revision=1)))
    assert len(inserted.patch.document.nodes) == 2
    assert len(second.patch.document.nodes) == 3
    assert sum(node.service_class == "f8.pystudio" and not isinstance(node, OperatorNode) for node in second.patch.document.nodes) == 1
