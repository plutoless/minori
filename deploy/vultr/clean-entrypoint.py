#!/usr/bin/python3 -I
"""Startup-safe boundary for the three installed deployment entrypoints."""

import os
import sys


entrypoint_path = os.path.realpath(__file__)
name = os.path.basename(entrypoint_path)
if name not in {"ci-deploy", "minori-release", "rehearse-release"}:
    raise SystemExit(2)

install_root = os.path.dirname(os.path.dirname(entrypoint_path))
target = os.path.join(install_root, "libexec", name)
environment = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C",
    "LC_ALL": "C",
    "MINORI_CLEAN_ENTRYPOINT": name,
}
if name == "ci-deploy" and "SSH_ORIGINAL_COMMAND" in os.environ:
    environment["SSH_ORIGINAL_COMMAND"] = os.environ["SSH_ORIGINAL_COMMAND"]

os.execve(target, [target, *sys.argv[1:]], environment)
