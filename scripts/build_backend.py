"""Package EC2 backend runtime files using only the Python standard library."""
from pathlib import Path
import ast
import hashlib
import io
import tarfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist" / "claim-wise-build"


def build():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    sources = [(p, p.relative_to(ROOT / "backend").as_posix())
               for p in sorted((ROOT / "backend/app").rglob("*.py"))
               if "__pycache__" not in p.parts]
    sources += [(p, p.relative_to(ROOT).as_posix())
                for p in sorted((ROOT / "fixtures").rglob("*"))
                if p.is_file() and "__pycache__" not in p.parts and not p.is_symlink()]
    sources += [(ROOT / "backend/requirements.txt", "requirements.txt"),
                (ROOT / "scripts/ec2-run.sh", "ec2-run.sh"),
                (ROOT / "scripts/ec2-infrastructure.yaml", "ec2-infrastructure.yaml"),
                (ROOT / "docs/ec2-backend.md", "DEPLOYMENT.md")]
    archive = OUTPUT / "claim-wise-backend.tar.gz"
    temporary = OUTPUT / "claim-wise-backend.tar.gz.tmp"
    try:
        with tarfile.open(temporary, "w:gz") as bundle:
            for source, name in sources:
                if source.is_symlink():
                    raise ValueError(f"Refusing symbolic link: {source}")
                content = source.read_bytes()
                if source.suffix in {".py", ".sh", ".txt", ".md", ".yaml"}:
                    content = content.replace(b"\r\n", b"\n")
                info = tarfile.TarInfo(name)
                info.size = len(content)
                info.mode = 0o755 if name.endswith(".sh") else 0o644
                bundle.addfile(info, io.BytesIO(content))
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)
    with tarfile.open(archive, "r:gz") as bundle:
        names = bundle.getnames()
        assert {"app/main.py", "app/worker.py", "requirements.txt", "ec2-infrastructure.yaml"} <= set(names)
        assert all(name.split("/")[0] in {
            "app", "fixtures", "requirements.txt", "ec2-run.sh", "ec2-infrastructure.yaml", "DEPLOYMENT.md"
        } for name in names)
        for name in names:
            assert not name.endswith(".env") and "__pycache__" not in name
            if name.endswith(".py"):
                ast.parse(bundle.extractfile(name).read(), filename=name)
        assert b"\r" not in bundle.extractfile("ec2-run.sh").read()
    for source, name in [(ROOT / "scripts/ec2-run.sh", "ec2-run.sh"),
                         (ROOT / "docs/ec2-backend.env.example", ".env.example"),
                         (ROOT / "docs/ec2-backend.md", "DEPLOYMENT.md")]:
        (OUTPUT / name).write_bytes(source.read_bytes().replace(b"\r\n", b"\n"))
    environment = OUTPUT / ".env"
    if not environment.exists():
        environment.write_bytes((OUTPUT / ".env.example").read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    # Bytes prevent Windows text-mode newline conversion to CRLF.
    (OUTPUT / "claim-wise-backend.tar.gz.sha256").write_bytes(
        f"{digest}  {archive.name}\n".encode("ascii"))
    print(f"Backend package: {archive} ({archive.stat().st_size:,} bytes)")
    print(f"Verified {len(names)} runtime files, Python syntax and Linux shell line endings.")
    print(f"Edit {environment} before uploading. Existing .env is preserved.")
    print("Upload this build folder's contents to /home/ec2-user/claim-wise-build/")


if __name__ == "__main__":
    build()
