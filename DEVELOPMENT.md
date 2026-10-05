# Development and publication

Prepare `.sdk` as a checkout of `feel8-fun/f8sdk` at a reviewed application-capable
commit. Inside the development workspace checkout, run:

```sh
pixi run -e build-check python scripts/workspace_inputs.py prepare
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

Run an independent Feel8 Platform daemon and set `F8_PLATFORM_CONNECTION_FILE`
to its `platform.json`. Shared `f8media_protocol`
contracts are supplied by `.sdk`; Gateway source is not a build input. WebStudio's frontend and backend must
have the same release version and are always published together. The frontend
build writes `f8-release.json`; the package validator rejects missing or mismatched
assets. Change backend metadata, frontend metadata and extension metadata together.

Development frontend output lives in `build/web-studio/` inside this repository.

The launcher implementation is not a WebStudio build or runtime dependency.
WebStudio uses the SDK's typed platform HTTP client. Its Extensions, Environments
and Tools pages display the daemon's inventory. Use the launcher tray for desktop
management; direct `serve` starts a source server without a tray. The daemon owns
Media Gateway and service processes. Frontend and backend are always published
as one application release. The development workspace supplies the integration
test platform; platform-only tests belong to the launcher repository.
