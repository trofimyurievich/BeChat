"""Package the BeChat Node server and the amoCRM widget from release sources."""
import argparse
import hashlib
import io
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
TOP = (".env.example", ".dockerignore", "Dockerfile", "compose.yaml", "package.json", "README.md", "channel-icon.svg")

def bundle(items):
    stream = io.BytesIO()
    with ZipFile(stream, "w", compression=ZIP_DEFLATED) as archive:
        for name, data in sorted(items):
            if (Path(name).suffix in {".md", ".txt", ".html", ".css", ".js", ".mjs", ".json", ".svg", ".sh", ".py", ".yaml", ".yml"}
                    or Path(name).name in {".env.example", ".dockerignore", "Dockerfile", "Caddyfile"}):
                data = data.replace(b"\r\n", b"\n")
            info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if name.endswith(".sh") else 0o100644) << 16
            archive.writestr(info, data, compress_type=ZIP_DEFLATED)
    return stream.getvalue()

def files(directory):
    for path in (ROOT / directory).rglob("*"):
        if not path.is_file():
            continue
        if directory == "personal" and (path.parent != ROOT / directory or path.suffix not in (".py", ".txt")):
            continue
        if directory == "dist" and (path.name.startswith("portrait-") or path.name in ("orbit.pdf", "orbit.jpg")):
            continue
        if directory == "server" and ((path.suffix != ".mjs" and path.name != "max-root.pem") or path.name == "user.mjs"):
            continue
        yield path.relative_to(ROOT).as_posix(), path.read_bytes()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "build" / "release")
    output = parser.parse_args().out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    widget = bundle((name.removeprefix("widget/"), data) for name, data in files("widget"))
    entries = [(name, (ROOT / name).read_bytes()) for name in TOP]
    for directory in ("server", "dist", "deploy", "docs", "tests", "personal"):
        entries.extend(files(directory))
    entries.append(("widget.zip", widget))
    server = bundle(entries)
    for name, data in [("widget.zip", widget), (f"BeChat-Server-{VERSION}.zip", server)]:
        with ZipFile(io.BytesIO(data)) as check:
            assert check.testzip() is None
        (output / name).write_bytes(data)
        print(hashlib.sha256(data).hexdigest(), name)

if __name__ == "__main__":
    main()

