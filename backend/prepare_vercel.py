"""Package repository fixtures into the independent backend project."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent
source = root.parent / "fixtures"
if not source.is_dir():
    raise RuntimeError("Enable access to files outside the backend Root Directory in Vercel project settings.")
shutil.copytree(source, root / "fixtures", dirs_exist_ok=True)
