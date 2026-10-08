from __future__ import annotations

import msgspec

from .models import ExtensionRequirement, OperatorRequirement, PublicationManifest


class InstalledExtension(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    extension_id: str
    version: str
    service_classes: tuple[str, ...] = ()
    operators: tuple[OperatorRequirement, ...] = ()
    protocol_versions: tuple[str, ...] = ()
    capabilities: tuple[str, ...] = ()


class DependencyIssue(msgspec.Struct, frozen=True, kw_only=True, rename="camel", forbid_unknown_fields=True):
    code: str
    extension_id: str
    requirement: str
    message: str


def diagnose_dependencies(manifest: PublicationManifest, installed: tuple[InstalledExtension, ...]) -> tuple[DependencyIssue, ...]:
    by_id = {extension.extension_id: extension for extension in installed}
    issues: list[DependencyIssue] = []
    for dependency in manifest.dependencies:
        actual = by_id.get(dependency.extension_id)
        if actual is None:
            issues.append(DependencyIssue(code="missing_extension", extension_id=dependency.extension_id,
                requirement=dependency.extension_id, message=f"Install extension {dependency.extension_id} to edit or run this asset; embedded definitions remain available for preview."))
            continue
        if dependency.compatible_versions and actual.version not in dependency.compatible_versions:
            issues.append(DependencyIssue(code="incompatible_extension_version", extension_id=dependency.extension_id,
                requirement=", ".join(dependency.compatible_versions), message=f"Extension {dependency.extension_id} is {actual.version}; accepted versions: {', '.join(dependency.compatible_versions)}."))
        for code, required, available in (
            ("missing_service", dependency.service_classes, actual.service_classes),
            ("missing_protocol", dependency.protocol_versions, actual.protocol_versions),
            ("missing_capability", dependency.capabilities, actual.capabilities),
        ):
            for item in sorted(set(required) - set(available)):
                issues.append(DependencyIssue(code=code, extension_id=dependency.extension_id, requirement=item,
                    message=f"Extension {dependency.extension_id} does not provide {item} ({code})."))
        available_operators = {(item.service_class, item.operator_class) for item in actual.operators}
        for item in dependency.operators:
            if (item.service_class, item.operator_class) not in available_operators:
                name = f"{item.service_class}/{item.operator_class}"
                issues.append(DependencyIssue(code="missing_operator", extension_id=dependency.extension_id, requirement=name,
                    message=f"Extension {dependency.extension_id} does not provide operator {name}."))
    return tuple(issues)


def validate_dependency_coverage(dependencies: tuple[ExtensionRequirement, ...], services: set[str], operators: set[tuple[str, str]]) -> None:
    ids = [item.extension_id for item in dependencies]
    if len(ids) != len(set(ids)) or any(not item.strip() for item in ids):
        raise ValueError("manifest extension IDs must be nonempty and unique")
    declared_services = {name for item in dependencies for name in item.service_classes}
    declared_operators = {(operator.service_class, operator.operator_class) for item in dependencies for operator in item.operators}
    missing = sorted(services - declared_services) + sorted(f"{service}/{operator}" for service, operator in operators - declared_operators)
    if missing:
        raise ValueError(f"manifest lacks extension ownership for: {', '.join(missing)}")
    for dependency in dependencies:
        for values in (dependency.compatible_versions, dependency.service_classes, dependency.protocol_versions, dependency.capabilities):
            if len(set(values)) != len(values) or any(not value.strip() for value in values):
                raise ValueError(f"manifest has empty or duplicate requirements for {dependency.extension_id}")
        pairs = [(item.service_class, item.operator_class) for item in dependency.operators]
        if len(set(pairs)) != len(pairs) or any(not service.strip() or not operator.strip() for service, operator in pairs):
            raise ValueError(f"manifest has invalid operator requirements for {dependency.extension_id}")
    # Do not infer extension ownership from class-name prefixes.
