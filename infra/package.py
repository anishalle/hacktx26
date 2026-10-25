"""Package the existing backend and Linux wheels for Lambda without Docker."""

import shutil
import subprocess
from pathlib import Path

INFRA = Path(__file__).resolve().parent
ROOT = INFRA.parent
BUILD = INFRA / ".build"
TARGET = BUILD / "lambda"


def main() -> None:
    # Only generated files inside infra/.build are replaced.
    if TARGET.exists():
        shutil.rmtree(TARGET)
    TARGET.mkdir(parents=True)
    requirements = BUILD / "requirements.txt"
    subprocess.run(
        [
            "uv",
            "export",
            "--frozen",
            "--no-dev",
            "--no-emit-project",
            "--no-hashes",
            "--output-file",
            str(requirements),
        ],
        cwd=ROOT,
        check=True,
    )
    subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--python-version",
            "3.12",
            "--python-platform",
            "x86_64-manylinux2014",
            "--only-binary",
            ":all:",
            "--target",
            str(TARGET),
            "-r",
            str(requirements),
            "mangum==0.19.0",
        ],
        cwd=ROOT,
        check=True,
    )
    shutil.copytree(
        ROOT / "backend" / "app",
        TARGET / "app",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    shutil.copy2(INFRA / "lambda_handler.py", TARGET / "lambda_handler.py")
    print(f"Lambda package ready: {TARGET}")


if __name__ == "__main__":
    main()
