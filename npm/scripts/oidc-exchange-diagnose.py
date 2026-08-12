#!/usr/bin/env python3
# Print the npm OIDC token-exchange response for the package, to see why
# trusted publishing is rejected (owner/repo case mismatch shows up here).
import json
import os
import urllib.error
import urllib.request

url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=npm:registry.npmjs.org"
token = os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
try:
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}"}
    )
    jwt = json.load(urllib.request.urlopen(req))["value"]
except (OSError, ValueError, KeyError) as e:
    print(f"OIDC token request failed: {e}", file=__import__("sys").stderr)
    raise SystemExit(1)

exchange = urllib.request.Request(
    "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/ap-browser-connect",
    data=b"",
    method="POST",
    headers={"Authorization": f"Bearer {jwt}"},
)
try:
    resp = urllib.request.urlopen(exchange)
    print("exchange status:", resp.status)
    print(resp.read().decode()[:500])
except urllib.error.HTTPError as e:
    print("exchange HTTP error:", e.code)
    print(e.read().decode()[:500])
