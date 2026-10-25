import importlib.util
from pathlib import Path

import pytest


@pytest.mark.parametrize("script", ["verify_calls", "verify", "create_teammates"])
def test_credential_refresh_has_region_without_profile_defaults(
    script,
    monkeypatch,
    tmp_path,
):
    path = Path(__file__).resolve().parents[2] / "infra" / f"{script}.py"
    spec = importlib.util.spec_from_file_location("helper_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
    if script == "create_teammates":
        monkeypatch.setattr(module, "TARGET", tmp_path / "unused-access-file.md")

    class StopBeforeAws(Exception):
        pass

    def capture(command, **kwargs):
        assert command[1:3] == ["configure", "export-credentials"]
        assert command[command.index("--region") + 1] == "us-east-1"
        raise StopBeforeAws

    monkeypatch.setattr(module.subprocess, "check_output", capture)
    with pytest.raises(StopBeforeAws):
        module.main()
