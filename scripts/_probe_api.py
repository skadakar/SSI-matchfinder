"""Exhaustive API key auth probe - check every plausible scheme."""
import json
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError
from datetime import date

env = {}
for line in Path(".env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    k, _, v = line.partition("=")
    env[k.strip()] = v.strip()
key = env.get("SSI_API_KEY", "")

GQL = "https://shootnscoreit.com/graphql/"
today = date.today().isoformat()

EVENTS_Q = """query($after: String!) {
  events(starts_after: $after) {
    ... on EventInterface { id name starts }
  }
}"""
ME_Q = "{ me { id } }"

def gql(query, variables=None, extra_headers=None):
    body = json.dumps({"query": query, **({"variables": variables} if variables else {})})
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               **(extra_headers or {})}
    req = Request(GQL, data=body.encode(), headers=headers)
    try:
        with urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:200]}

def label(r):
    if "http_error" in r:
        return f"HTTP {r['http_error']}"
    errs = [e["message"] for e in r.get("errors", [])]
    if errs:
        return f"GQL error: {errs[0][:60]}"
    d = r.get("data", {})
    return f"DATA: {str(d)[:80]}"

schemes = [
    ("no auth",           {}),
    ("Token",             {"Authorization": f"Token {key}"}),
    ("Bearer",            {"Authorization": f"Bearer {key}"}),
    ("Api-Key header",    {"Authorization": f"Api-Key {key}"}),
    ("X-API-Key",         {"X-API-Key": key}),
    ("X-Auth-Token",      {"X-Auth-Token": key}),
    ("X-Api-Key",         {"X-Api-Key": key}),
    ("X-Token",           {"X-Token": key}),
]

print("=== me query vs auth scheme ===")
for name, hdrs in schemes:
    r = gql(ME_Q, extra_headers=hdrs)
    print(f"  [{name:18}] {label(r)}")

print("\n=== events query vs auth scheme ===")
for name, hdrs in schemes:
    r = gql(EVENTS_Q, {"after": today}, extra_headers=hdrs)
    print(f"  [{name:18}] {label(r)}")

# Also try URL-param based auth
print("\n=== events via URL params ===")
import urllib.parse
for param in ["token", "api_key", "key"]:
    url = f"{GQL}?{param}={key}"
    body = json.dumps({"query": EVENTS_Q, "variables": {"after": today}}).encode()
    req = Request(url, data=body, headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode())
            print(f"  [?{param}=...] {label(data)}")
    except HTTPError as e:
        print(f"  [?{param}=...] HTTP {e.code}")

# Try verify_token mutation with the API key (in case it's a JWT or opaque token)
print("\n=== verify_token with API key ===")
r = gql('mutation { verify_token(token: "' + key + '") { payload } }')
print(label(r))

import json, re
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError

env = {}
for line in Path(".env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    k, _, v = line.partition("=")
    env[k.strip()] = v.strip()
key = env.get("SSI_API_KEY", "")

GQL = "https://shootnscoreit.com/graphql/"

def gql(query, variables=None, auth=None):
    body = json.dumps({"query": query, **({"variables": variables} if variables else {})})
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if auth:
        headers["Authorization"] = auth
    req = Request(GQL, data=body.encode(), headers=headers)
    with urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

# 1. Introspect the Mutation type
print("=== Mutation fields ===")
r = gql('{ __type(name: "Mutation") { fields { name args { name type { name kind ofType { name } } } } } }')
for f in r["data"]["__type"]["fields"]:
    args = [(a["name"], a["type"]["name"] or (a["type"].get("ofType") or {}).get("name","?"))
            for a in f["args"]]
    print(f"  {f['name']:40} args={args}")

# 2. Scan app.js for token/jwt auth patterns (last 300KB is usually main app code)
print("\n=== Auth patterns in app.js ===")
req = Request("https://shootnscoreit.com/static/spark/js/app.js",
              headers={"User-Agent": "Mozilla/5.0"})
with urlopen(req, timeout=30) as r:
    js = r.read().decode("utf-8", errors="replace")

# Look specifically for TokenAuth mutation or api_key usage
for pattern in [r"tokenAuth", r"apiKey", r"api_key", r"verify_token",
                r"verifyToken", r"token_auth", r"Authorization"]:
    hits = re.findall(r'.{0,50}' + pattern + r'.{0,80}', js, re.IGNORECASE)
    unique = list({h.strip() for h in hits})[:3]
    for h in unique:
        print(f"  [{pattern}] {h[:120]}")

import json
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError
from datetime import date

env = {}
for line in Path(".env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    k, _, v = line.partition("=")
    env[k.strip()] = v.strip()
key = env.get("SSI_API_KEY", "")

GQL = "https://shootnscoreit.com/graphql/"

def gql(query, variables=None, auth=None):
    body = json.dumps({"query": query, **({"variables": variables} if variables else {})})
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if auth:
        headers["Authorization"] = auth
    req = Request(GQL, data=body.encode(), headers=headers)
    with urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

today = date.today().isoformat()
auth = f"Token {key}"

EVENTS_Q = """query($after: String!) {
  events(starts_after: $after) {
    ... on EventInterface { id name starts }
  }
}"""

print("=== events: no auth ===")
r = gql(EVENTS_Q, {"after": today})
err = [e["message"] for e in r.get("errors", [])]
data = r.get("data", {})
print("errors:", err, "| data keys:", list(data.keys()) if data else None)

print("\n=== events: Token auth ===")
r = gql(EVENTS_Q, {"after": today}, auth=auth)
err = [e["message"] for e in r.get("errors", [])]
if not err:
    events = r["data"]["events"]
    print(f"Got {len(events)} events")
    print(json.dumps(events[:2], indent=2, default=str))
else:
    print("errors:", err)

print("\n=== Try organizations query ===")
r = gql("{ organizations { id name city country } }", auth=auth)
err = [e["message"] for e in r.get("errors", [])]
if not err:
    orgs = r["data"]["organizations"]
    print(f"Got {len(orgs) if orgs else 0} orgs")
    if orgs:
        print("First org:", json.dumps(orgs[0], default=str))
        # Now try events via the org id
        org_id = orgs[0]["id"]
        print(f"\n=== events for org {org_id} ===")
        r2 = gql("""query($id: ID!, $after: String!) {
          organization(id: $id) {
            events(starts_after: $after) {
              ... on EventInterface { id name starts rule venue lat lng
                organizer { name city country lat lng }
              }
            }
          }
        }""", {"id": org_id, "after": today}, auth=auth)
        if "errors" in r2:
            print("errors:", [e["message"] for e in r2["errors"]])
        else:
            ev = r2["data"]["organization"]["events"]
            print(f"Got {len(ev)} events")
            print(json.dumps(ev[:2], indent=2, default=str))
else:
    print("errors:", err)

import json
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError
from datetime import date

env = {}
for line in Path(".env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    k, _, v = line.partition("=")
    env[k.strip()] = v.strip()
key = env.get("SSI_API_KEY", "")

GQL = "https://shootnscoreit.com/graphql/"

def gql(query, variables=None, auth=None):
    body = json.dumps({"query": query, **({"variables": variables} if variables else {})})
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if auth:
        headers["Authorization"] = auth
    req = Request(GQL, data=body.encode(), headers=headers)
    with urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

ME_QUERY = "{ me { id } }"
today = date.today().isoformat()
EVENTS_QUERY = """
query($after: String!) {
  events(starts_after: $after) {
    ... on EventInterface { id name starts }
  }
}
"""

print("=== Auth scheme test (me query) ===")
for label, auth in [
    ("Token", f"Token {key}"),
    ("Bearer", f"Bearer {key}"),
    ("X-Auth (no prefix)", key),
]:
    try:
        r = gql(ME_QUERY, auth=auth)
        err = r.get("errors", [{}])[0].get("message", "ok")
        data = r.get("data", {})
        print(f"  [{label}] {'DATA:' + str(data) if data else 'ERROR: ' + err}")
    except HTTPError as e:
        print(f"  [{label}] HTTP {e.code}")

print("\n=== events query (Token auth) ===")
try:
    r = gql(EVENTS_QUERY, {"after": today}, auth=f"Token {key}")
    if "errors" in r:
        print("Errors:", [e["message"] for e in r["errors"]])
    else:
        events = r["data"]["events"]
        print(f"Got {len(events)} events. First 2:")
        print(json.dumps(events[:2], indent=2, default=str))
except Exception as e:
    print("Exception:", e)

import json
from pathlib import Path
from urllib.request import urlopen, Request
from datetime import date

env = {}
for line in Path(".env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    k, _, v = line.partition("=")
    env[k.strip()] = v.strip()
key = env.get("SSI_API_KEY", "")

GQL = "https://shootnscoreit.com/graphql/"

def gql(query, variables=None):
    body = json.dumps({"query": query, **({"variables": variables} if variables else {})})
    req = Request(GQL, data=body.encode(),
                  headers={"Content-Type": "application/json",
                           "Accept": "application/json",
                           "Authorization": f"Token {key}"})
    with urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

today = date.today().isoformat()
result = gql("""
query($after: String!) {
  events(starts_after: $after) {
    ... on EventInterface {
      id name starts ends rule sub_rule venue lat lng
      registration registration_closes is_registration_possible
      competitors_count url get_full_rule_display
      organizer { name city country lat lng }
    }
  }
}
""", {"after": today})

if "errors" in result:
    print("ERRORS:")
    for e in result["errors"]:
        print(" ", e["message"])
else:
    events = result["data"]["events"]
    print(f"Got {len(events)} events. First 2:")
    print(json.dumps(events[:2], indent=2, default=str))

import json
from pathlib import Path
from urllib.request import urlopen, Request
from datetime import date

env = {}
for line in Path(".env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    k, _, v = line.partition("=")
    env[k.strip()] = v.strip()
key = env.get("SSI_API_KEY", "")

GQL = "https://shootnscoreit.com/graphql/"
AUTH = f"Token {key}"

def gql(query, variables=None):
    body = json.dumps({"query": query, **({"variables": variables} if variables else {})})
    req = Request(GQL, data=body.encode(),
                  headers={"Content-Type": "application/json",
                           "Accept": "application/json",
                           "Authorization": AUTH})
    with urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

# 1. Introspect EventInterface
print("=== EventInterface fields ===")
result = gql('{ __type(name: "EventInterface") { fields { name type { name kind ofType { name kind } } } } }')
for f in result["data"]["__type"]["fields"]:
    t = f["type"]
    tn = t["name"] or (t.get("ofType") or {}).get("name", "?")
    print(f"  {f['name']:35} {tn}")

# 2. Introspect OrganizationNode
print("\n=== OrganizationNode fields ===")
result = gql('{ __type(name: "OrganizationNode") { fields { name type { name kind ofType { name kind } } } } }')
for f in result["data"]["__type"]["fields"]:
    t = f["type"]
    tn = t["name"] or (t.get("ofType") or {}).get("name", "?")
    print(f"  {f['name']:35} {tn}")

# 3. Sample events query — fetch first 3 upcoming events
print("\n=== Sample events query (first 3 upcoming) ===")
today = date.today().isoformat()
result = gql("""
query SampleEvents($after: String!) {
  events(starts_after: $after) {
    ... on IpscMatchNode  { id name startDate endDate registrationDeadline registrationOpen participantCount
      organization { name region country }
      location venue lat lng }
    ... on GenericMatchNode { id name startDate endDate registrationDeadline registrationOpen participantCount
      organization { name region country }
      location venue lat lng }
    ... on SteelMatchNode { id name startDate endDate
      organization { name region country }
      location venue lat lng }
    ... on IdpaMatchNode { id name startDate endDate
      organization { name region country }
      location venue lat lng }
    ... on NordicMatchNode { id name startDate endDate
      organization { name region country }
      location venue lat lng }
    ... on PrecisionMatchNode { id name startDate endDate
      organization { name region country }
      location venue lat lng }
    ... on SassMatchNode { id name startDate endDate
      organization { name region country } }
    ... on PpcMatchNode  { id name startDate endDate
      organization { name region country } }
    ... on CmpMatchNode  { id name startDate endDate
      organization { name region country } }
  }
}
""", {"after": today})
if "errors" in result:
    print("Errors:", result["errors"])
else:
    events = result["data"]["events"]
    print(f"Got {len(events)} events")
    print(json.dumps(events[:3], indent=2, default=str))

import json
from pathlib import Path
from urllib.request import urlopen, Request

env = {}
for line in Path(".env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    k, _, v = line.partition("=")
    env[k.strip()] = v.strip()
key = env.get("SSI_API_KEY", "")

GQL = "https://shootnscoreit.com/graphql/"
AUTH = f"Token {key}"

def gql(query, variables=None):
    body = json.dumps({"query": query, **({"variables": variables} if variables else {})})
    req = Request(GQL, data=body.encode(),
                  headers={"Content-Type": "application/json",
                           "Accept": "application/json",
                           "Authorization": AUTH})
    with urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

# 1. Get all fields on RootQuery
print("=== RootQuery fields ===")
result = gql("""
{
  __type(name: "RootQuery") {
    fields {
      name
      type { name kind ofType { name kind } }
      args { name type { name kind } }
    }
  }
}
""")
fields = result["data"]["__type"]["fields"]
for f in fields:
    t = f["type"]
    type_name = t["name"] or (t.get("ofType") or {}).get("name", "")
    args = [a["name"] for a in f["args"]]
    print(f"  {f['name']:35} → {type_name}  args={args}")

import json, re
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError

# Load key from .env without printing it
env = {}
for line in Path(".env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    k, _, v = line.partition("=")
    env[k.strip()] = v.strip()
key = env.get("SSI_API_KEY", "")

INTROSPECTION = json.dumps({"query": "{ __schema { queryType { name } types { name kind } } }"})
SIMPLE_QUERY  = json.dumps({"query": "{ __typename }"})

def post_graphql(url, body, auth=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if auth:
        headers["Authorization"] = auth
    req = Request(url, data=body.encode(), headers=headers, method="POST")
    with urlopen(req, timeout=15) as r:
        return r.status, json.loads(r.read().decode())

def get(url, auth=None):
    headers = {"Accept": "application/json"}
    if auth:
        headers["Authorization"] = auth
    req = Request(url, headers=headers)
    with urlopen(req, timeout=10) as r:
        return r.status, r.read().decode()

# --- 1. Find GraphQL endpoint ---
print("=== GraphQL endpoint probe ===")
gql_candidates = [
    "https://shootnscoreit.com/graphql",
    "https://shootnscoreit.com/graphql/",
    "https://shootnscoreit.com/api/graphql",
    "https://shootnscoreit.com/api/graphql/",
    "https://shootnscoreit.com/api/v2/graphql",
    "https://shootnscoreit.com/api/v2/graphql/",
]
working_gql = None
for url in gql_candidates:
    for auth in [f"Token {key}", f"Bearer {key}", None]:
        try:
            status, data = post_graphql(url, SIMPLE_QUERY, auth)
            print(f"  OK {status} [{auth and auth.split()[0] or 'no-auth'}] {url}")
            print(f"    response: {str(data)[:120]}")
            if not working_gql:
                working_gql = (url, auth)
        except HTTPError as e:
            body = e.read().decode()[:80]
            print(f"  {e.code} [{auth and auth.split()[0] or 'no-auth'}] {url}: {body}")
        except Exception as e:
            print(f"  ERR [{auth and auth.split()[0] or 'no-auth'}] {url}: {type(e).__name__}: {e}")
        break  # only try first auth per URL unless it fails with 403

# --- 2. If we found a working endpoint, introspect ---
if working_gql:
    gql_url, auth = working_gql
    print(f"\n=== Introspecting {gql_url} ===")
    try:
        status, data = post_graphql(gql_url, INTROSPECTION, auth)
        types = data.get("data", {}).get("__schema", {}).get("types", [])
        print("Types:")
        for t in types:
            if not t["name"].startswith("__"):
                print(f"  {t['kind']:15} {t['name']}")
    except Exception as e:
        print("Introspection failed:", e)
else:
    print("\nNo working GraphQL endpoint found — trying REST fallback scan of app.js")
    from urllib.request import urlopen, Request as Req
    req = Req("https://shootnscoreit.com/static/spark/js/app.js",
              headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=20) as r:
        js = r.read().decode("utf-8", errors="replace")
    # GraphQL strings are often quoted in minified JS
    gql_hits = re.findall(r'["\`]([^"\`]*graphql[^"\`]*)["\`]', js, re.IGNORECASE)
    for h in sorted(set(gql_hits))[:20]:
        print(" ", h)
