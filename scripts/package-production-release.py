#!/usr/bin/env python3
"""Package the downloaded, verified 2026-10-02 preview as a frozen release.

The caller must first obtain the immutable Netlify deploy artifact and verify
its provenance. This script verifies that artifact's receipt and file inventory;
it does not invent a signed receipt or fetch mutable local preview content.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import tempfile

EXPECTED_COMMIT = "ee1c49d6ed8e32ee17493a5c395bfe9245a60d52"
EXPECTED_DEPLOY = "6abf25ef581f89000876e7fa"
AUTHORIZED_DEMOS = sorted([
    "air-quality-day-segment-pca-and-amp-umap-by-sensor",
    "alzheimer-s-gene-co-expression-explorer", "battery-curve-shape-explorer",
    "ceemdan-battery-forecasting", "from-twelve-thousand-numbers-to-a-codebook",
    "from-twenty-thousand-genes-to-fourteen-cell-types", "galaxy2-does-rotation-augmentation-help",
    "jae-joint-embedding-how-one-cell-becomes-61-numbers", "pleiades-membership-explorer",
    "singapore-road-speed-clusters-umap", "soh-battery", "superconductor-regression-explorer",
    "tbb-cluster-explorer-2",
])
EXCLUDED = {"_headers", "_redirects", "robots.txt", "deploy-receipt.json", "netlify.toml"}
MAX_TOTAL = 256 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError("Production package: " + message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    return 0 < len(name) < 240 and all(
        re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", part) and part not in (".", "..")
        for part in name.split("/")
    )


def read_regular(file):
    require(stat.S_ISREG(file.lstat().st_mode), "source is not a regular file: " + file.name)
    require(file.stat().st_size <= MAX_FILE, "source file exceeds size limit: " + file.name)
    return file.read_bytes()


def package_release(source, output):
    # Reject a symlink as the supplied source itself, as well as all entries.
    require(source.is_dir() and not source.is_symlink(), "source must be a real directory")
    source = source.resolve()
    output = output.absolute()
    require(output.suffix == ".json" and safe_path(output.name), "output must name a JSON release manifest")
    output.parent.mkdir(parents=True, exist_ok=True)
    output = output.parent.resolve() / output.name
    require(not output.is_relative_to(source), "output must be outside the downloaded source")
    require(not output.exists(), "output manifest already exists; use a new release location")
    archive_path = output.with_suffix(".tar.gz")
    require(not archive_path.exists(), "output archive already exists; use a new release location")

    receipt_bytes = read_regular(source / "deploy-receipt.json")
    receipt = json.loads(receipt_bytes)
    expected = {"schema": 1, "registry_schema": 3, "verified": True, "revision_bound": True,
                "platform": "netlify", "target": "preview", "audience": "preview",
                "context": "branch-deploy", "branch": "develop",
                "commit_ref": EXPECTED_COMMIT, "deploy_id": EXPECTED_DEPLOY}
    for key, value in expected.items():
        require(type(receipt.get(key)) is type(value) and receipt[key] == value,
                "source receipt does not match reviewed preview: " + key)
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", receipt.get("registry_revision", "")), "invalid registry revision")
    require(re.fullmatch(r"[a-f0-9-]{20,64}", receipt.get("site_id", ""), re.IGNORECASE), "missing preview site identity")
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", receipt.get("build_id", "")), "missing preview build identity")
    require(re.fullmatch(r"[a-z0-9-]+", receipt.get("registry_instance", "")), "missing registry instance")
    public_manifest_bytes = read_regular(source / "manifest.json")
    public_manifest = json.loads(public_manifest_bytes)
    require(public_manifest.get("schema_version") == 3, "public manifest is not Registry v3")
    require(sorted(d.get("slug", "") for d in public_manifest.get("demos", [])) == AUTHORIZED_DEMOS,
            "public manifest must contain exactly the authorized 13 demos")

    paths = []
    for directory, directories, filenames in os.walk(source, followlinks=False):
        for name in directories:
            entry = Path(directory) / name
            require(not entry.is_symlink(), "source contains a directory symlink")
        for name in filenames:
            entry = Path(directory) / name
            require(stat.S_ISREG(entry.lstat().st_mode), "source contains a symlink or special file")
            relative = entry.relative_to(source).as_posix()
            if relative in EXCLUDED:
                continue
            require(safe_path(relative), "unsafe source path: " + relative)
            require(entry.stat().st_size <= MAX_FILE, "source file exceeds size limit: " + relative)
            paths.append(relative)
    paths.sort()
    require(0 < len(paths) <= 10000 and "index.html" in paths, "invalid or incomplete file inventory")
    require(sum((source / name).stat().st_size for name in paths) <= MAX_TOTAL, "source exceeds release size limit")

    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".production-package-", delete=False) as handle:
            temporary = Path(handle.name)
            inventory = []
            with gzip.GzipFile(filename="", fileobj=handle, mode="wb", mtime=0, compresslevel=9) as compressed:
                with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                    for name in paths:
                        content = read_regular(source / name)
                        if name == "manifest.json":
                            require(content == public_manifest_bytes, "public manifest changed during packaging")
                        info = tarfile.TarInfo(name)
                        info.size = len(content)
                        info.mode = 0o644
                        info.mtime = 0
                        info.uid = info.gid = 0
                        info.uname = info.gname = ""
                        archive.addfile(info, io.BytesIO(content))
                        inventory.append({"path": name, "size": len(content), "sha256": digest(content)})
        require(read_regular(source / "deploy-receipt.json") == receipt_bytes, "source receipt changed during packaging")
        require(sum(item["size"] for item in inventory) <= MAX_TOTAL, "source grew beyond release size limit")
        require(temporary.stat().st_size <= 200 * 1024 * 1024, "archive exceeds release size limit")
        archive_hash = hashlib.sha256()
        with temporary.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                archive_hash.update(block)
        manifest = {
            "schema": 1,
            "archive": {"path": archive_path.name, "sha256": archive_hash.hexdigest()},
            "source": {"verified": True, "commit_ref": receipt["commit_ref"],
                       "registry_revision": receipt["registry_revision"], "deploy_id": receipt["deploy_id"],
                       "receipt_sha256": digest(receipt_bytes), "site_id": receipt["site_id"],
                       "build_id": receipt["build_id"], "registry_instance": receipt["registry_instance"]},
            "demo_slugs": AUTHORIZED_DEMOS,
            "files": inventory,
        }
        # Refuse replacement; an existing release remains a distinct artifact.
        os.link(temporary, archive_path)
        try:
            with output.open("x", encoding="utf-8") as handle:
                json.dump(manifest, handle, indent=2)
                handle.write("\n")
        except BaseException:
            archive_path.unlink()
            raise
        return manifest
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = package_release(args.source, args.output)
    print("Packaged reviewed preview: {} demos, {} files; archive SHA-256 {}".format(
        len(result["demo_slugs"]), len(result["files"]), result["archive"]["sha256"]))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError) as error:
        raise SystemExit(str(error)) from error
