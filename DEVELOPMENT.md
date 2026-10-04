# Development and publication

Prepare `.sdk` as a checkout of `feel8-fun/f8sdk` at a reviewed component-capable
commit. Inside the distribution checkout, run:

```sh
pixi run -e build-check python scripts/component_workspace.py prepare
```

Build dependencies live in `.ci/pixi.toml` and `.ci/pixi.lock`. Runtime dependencies
live in the repository's root workspace and lock. Environment names are local;
no Studio rule limits their names or number.

Publish independently:

```sh
pixi run --locked --manifest-path .ci/pixi.toml publish
```

The publisher builds this implementation's wheel, converts declared local library
inputs to wheels, locks the portable runtime and writes a ZIP plus SHA-256 in
`dist/`. No other application implementation is compiled. Configure the publisher
workflow with reviewed dependency commits; it uploads artifacts, not a remote release.

Prepare `.platform` from `feel8-fun/f8platform` and `.media-dependency` from
`feel8-fun/f8mediagateway`. Only the latter's `f8media_protocol` library is a build
input; its gateway service is not built. WebStudio's frontend and backend must
have the same release version and are always published together. The frontend
build writes `f8-release.json`; the package validator rejects missing or mismatched
assets. Change backend metadata, frontend metadata and component metadata together.

Development frontend output lives in `build/web-studio/` inside this repository.
