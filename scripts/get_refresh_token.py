#!/usr/bin/env python
"""
One-time setup script: exchange your SSI email+password for a refresh token.
Run this once locally; the refresh token goes into .env (and GitHub Secrets).
Your password is never stored anywhere.

Usage:
    python scripts/get_refresh_token.py
"""
import json, getpass
from urllib.request import urlopen, Request

GQL = "https://shootnscoreit.com/graphql/"

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

req = Request(GQL, data=body, headers={"Content-Type": "application/json", "Accept": "application/json"})
with urlopen(req, timeout=20) as r:
    result = json.loads(r.read().decode())

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
