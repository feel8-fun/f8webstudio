"""Publish WebStudio frontend and backend as one indivisible component."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from typing import Literal

from f8pysdk.component_package import read_component
from f8pysdk.component_packaging import build_component


def main() -> None:
    root = Path(__file__).resolve().parent
    manifest = read_component(root)
    frontend = json.loads((root / 'f8studio_web/package.json').read_text())
    if frontend['version'] != manifest.version:
        raise ValueError('Frontend version must match WebStudio release')
    npm = 'npm.cmd' if sys.platform == 'win32' else 'npm'
    subprocess.run([npm, 'ci'], cwd=root / 'f8studio_web', check=True)
    subprocess.run([npm, 'run', 'build'], cwd=root / 'f8studio_web', check=True)
    assets = root / 'build/web-studio'
    wheels = root / 'build/wheels'
    wheels.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='f8-webstudio-wheel-') as temporary:
        staged = Path(temporary) / 'server'
        shutil.copytree(root / 'f8studio_server', staged,
                        ignore=shutil.ignore_patterns('build', 'dist', '__pycache__', '*.egg-info', 'web_dist'))
        shutil.copytree(assets, staged / 'f8studio_server/web_dist')
        subprocess.run([sys.executable, '-m', 'pip', 'wheel', '--no-deps', '--no-build-isolation',
                        '-w', str(wheels), str(staged)], check=True)
    candidates = list(wheels.glob(f'f8studio_server-{manifest.version}-*.whl'))
    if len(candidates) != 1:
        raise ValueError('Expected one WebStudio backend wheel for this version')
    platform: Literal['linux-x86_64', 'windows-x86_64'] = 'windows-x86_64' if sys.platform == 'win32' else 'linux-x86_64'
    output = build_component(root, candidates[0], root / f'dist/webstudio-{manifest.version}-{platform}.zip',
                             web_assets=assets, platform=platform)
    output.with_suffix('.zip.sha256').write_text(hashlib.sha256(output.read_bytes()).hexdigest() + '  ' + output.name + '\n')
    print(output)


if __name__ == '__main__':
    main()
