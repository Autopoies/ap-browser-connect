#!/usr/bin/env python3
# Print the GitHub Actions OIDC token claims npm will match against a
# Trusted Publisher config (owner/repo/ref/environment). Debug aid for
# "npm error E404 ... is not in this registry" on publish.
import base64
import json
import os
import urllib.request

url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=registry.npmjs.org"
token = os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
try:
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}"}
    )
    jwt = json.load(urllib.request.urlopen(req))["value"]
except (OSError, ValueError, KeyError) as e:
    print(f"OIDC token request failed: {e}", file=__import__("sys").stderr)
    raise SystemExit(1)

payload = jwt.split(".")[1]
payload += "=" * (-len(payload) % 4)
try:
    claims = json.loads(base64.urlsafe_b64decode(payload))
except (ValueError, TypeError) as e:
    print(f"OIDC token decode failed: {e}", file=__import__("sys").stderr)
    raise SystemExit(1)
print("OIDC subject:", claims.get("sub"))
print("OIDC repository:", claims.get("repository"))
print("OIDC ref:", claims.get("ref"))
print("OIDC environment:", claims.get("environment"))
print("OIDC job_workflow_ref:", claims.get("job_workflow_ref"))
