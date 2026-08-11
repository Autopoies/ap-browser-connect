#!/usr/bin/env python3
"""Throwaway native host for verifying Chrome native messaging framing.

Run as the `path` of `com.apbrowser.connect.json` while developing.

What it does (Phase 1 only):
  1. Read frames from stdin (4-byte LE length prefix + UTF-8 JSON).
  2. Log every received message to /tmp/ap-browser-host.log.
  3. Reply to JSON-RPC `ping` requests with a `pong` response.
  4. Reply to `hello` notifications with a no-op ack notification.
  5. Reply to any other request with an error.

Usage:
  1. Edit ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.apbrowser.connect.json
     and set `"path": "/path/to/ap-browser-connect/tests/py-host.py"`.
  2. Make this file executable: chmod +x tests/py-host.py.
  3. Reload the extension at chrome://extensions.
  4. Tail /tmp/ap-browser-host.log to see what the SW is sending.
"""

import json
import os
import struct
import sys
from pathlib import Path

LOG = Path("/tmp/ap-browser-host.log")
LOG.parent.mkdir(parents=True, exist_ok=True)
log_fh = LOG.open("a", buffering=1)  # line-buffered


def log(msg):
    log_fh.write(f"{msg}\n")
    log_fh.flush()


def read_frame():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    payload = sys.stdin.buffer.read(length)
    if len(payload) < length:
        return None
    return json.loads(payload.decode("utf-8"))


def write_frame(obj):
    payload = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def handle(msg):
    if not isinstance(msg, dict):
        return None
    has_id = "id" in msg
    method = msg.get("method")
    log(f"recv method={method} has_id={has_id} params={msg.get('params')}")

    if method == "hello":
        # SW connection handshake. No response (notification).
        params = msg.get("params", {})
        log(f"  hello.instance_id={params.get('instance_id')}")
        log(f"  hello.label={params.get('label')!r}")
        log(f"  hello.active_tab={params.get('active_tab')}")
        return None  # notification, no ack

    if method == "keepalive":
        return None  # notification

    if not has_id:
        return None  # unknown notification

    if method == "ping":
        return {
            "jsonrpc": "2.0",
            "id": msg["id"],
            "result": {
                "ok": True,
                "data": {"pong": True},
                "meta": {"duration_ms": 0, "focus": None, "profile": None},
            },
        }

    if method == "info":
        return {
            "jsonrpc": "2.0",
            "id": msg["id"],
            "result": {
                "ok": True,
                "data": {
                    "instance_id": "(unknown until hello)",
                    "label": "",
                    "active_tab": None,
                    "open_tabs": [],
                },
                "meta": {"duration_ms": 0, "focus": None, "profile": None},
            },
        }

    return {
        "jsonrpc": "2.0",
        "id": msg["id"],
        "error": {
            "code": "UNKNOWN_METHOD",
            "message": f"py-host does not implement {method}",
        },
    }


def main():
    log(f"--- py-host.py started, pid={os.getpid()} ---")
    while True:
        msg = read_frame()
        if msg is None:
            log("stdin closed, exiting")
            break
        resp = handle(msg)
        if resp is not None:
            write_frame(resp)
    log("--- py-host.py exit ---")


if __name__ == "__main__":
    main()
