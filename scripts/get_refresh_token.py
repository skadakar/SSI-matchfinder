#!/usr/bin/env python
"""
One-time setup script: exchange your SSI email+password for a refresh token.
Run this once locally; the refresh token goes into .env (and GitHub Secrets).
Your password is never stored anywhere.

Usage:
    python scripts/get_refresh_token.py
"""
import json, getpass, os, sys
from urllib.error import HTTPError, URLError
from urllib.request import urlopen, Request

GQL = "https://shootnscoreit.com/graphql/"

# The API requires an x-api-key header on every request, including token_auth.
API_KEY = os.environ.get("SSI_API_KEY", "").strip()
if not API_KEY:
    API_KEY = input("SSI API key (SSI_API_KEY, required by the API): ").strip()
if not API_KEY:
    print("Error: SSI_API_KEY is required (set it in the environment or enter it above).", file=sys.stderr)
    raise SystemExit(1)

email = input("SSI email: ").strip()
password = getpass.getpass("SSI password (not stored): ")

body = json.dumps({"query": """
mutation TokenAuth($email: String!, $password: String!) {
  token_auth(email: $email, password: $password) {
    success
    errors
    token { token }
    refresh_token { token }
  }
}
""", "variables": {"email": email, "password": password}}).encode()

req = Request(GQL, data=body, headers={
    "Content-Type": "application/json",
    "Accept": "application/json",
    "x-api-key": API_KEY,
})
try:
    with urlopen(req, timeout=20) as r:
        status = r.status
        raw = r.read().decode()
except HTTPError as e:
    raw = e.read().decode(errors="replace")
    print(f"HTTP Error {e.code}: {e.reason}", file=sys.stderr)
    print("Response headers:", file=sys.stderr)
    for k, v in e.headers.items():
        print(f"  {k}: {v}", file=sys.stderr)
    print("Response body:", file=sys.stderr)
    print(raw, file=sys.stderr)
    if e.code == 401:
        print(
            "\nHint: a 401 here usually means the x-api-key header is missing/invalid,\n"
            "not that your email/password is wrong. Double-check SSI_API_KEY.",
            file=sys.stderr,
        )
    raise SystemExit(1)
except URLError as e:
    print(f"Connection error: {e.reason}", file=sys.stderr)
    raise SystemExit(1)

try:
    result = json.loads(raw)
except json.JSONDecodeError:
    print(f"Error: server returned non-JSON response (HTTP {status}):", file=sys.stderr)
    print(raw, file=sys.stderr)
    raise SystemExit(1)

if "errors" in result:
    for e in result["errors"]:
        print("Error:", e["message"])
    raise SystemExit(1)

data = result["data"]["token_auth"]
if not data.get("success"):
    print("Login failed:", data.get("errors"))
    raise SystemExit(1)

refresh_token = data["refresh_token"]["token"]
jwt = data["token"]["token"]

print("\nSuccess!")
print(f"Refresh token: {refresh_token}")
print("\nAdd this line to your .env:")
print(f"SSI_REFRESH_TOKEN={refresh_token}")
print("\nAnd add SSI_REFRESH_TOKEN as a GitHub Actions secret.")
print("You do NOT need to store your password anywhere.")
