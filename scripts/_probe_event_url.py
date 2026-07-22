"""Probe EventInterface fields and fetch one event's raw data to find the URL pattern."""
import json, os
from pathlib import Path
from urllib.request import urlopen, Request

for line in Path('.env').read_text(encoding='utf-8').splitlines():
    line = line.strip()
    if not line or line.startswith('#'): continue
    eq = line.find('=')
    if eq == -1: continue
    k, v = line[:eq].strip(), line[eq+1:].strip()
    if k and k not in os.environ: os.environ[k] = v

GQL = 'https://shootnscoreit.com/graphql/'

def gql(q, v=None, auth=None, key=None):
    body = json.dumps({'query': q, **(({'variables': v}) if v else {})}).encode()
    h = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if auth: h['Authorization'] = auth
    if key: h['x-api-key'] = key
    with urlopen(Request(GQL, data=body, headers=h), timeout=20) as r:
        return json.loads(r.read())

# Auth
rt = gql(
    'mutation R($rt:String!){refresh_token(refresh_token:$rt,revoke_refresh_token:false){success token{token}}}',
    {'rt': os.environ['SSI_REFRESH_TOKEN']}
)
jwt = rt['data']['refresh_token']['token']['token']
auth = f'JWT {jwt}'
key = os.environ['SSI_API_KEY']

# 1. All EventInterface fields
print("=== EventInterface fields ===")
r = gql('{ __type(name: "EventInterface") { fields { name type { name kind ofType { name } } } } }')
for f in r['data']['__type']['fields']:
    print(f['name'], '->', f['type'])

# 2. Fetch the Hokksund event raw to see all values
print("\n=== Raw event for Hokksund (2026-07-23) ===")
q = """
query {
  events(starts_after: "2026-07-22", starts_before: "2026-07-24") {
    ... on EventInterface {
      id name url slug organizer { id name }
    }
  }
}
"""
r = gql(q, auth=auth, key=key)
if 'errors' in r:
    print("errors:", r['errors'])
    # try without slug/id on organizer
    q2 = """
    query {
      events(starts_after: "2026-07-22", starts_before: "2026-07-24") {
        ... on EventInterface {
          id name url organizer { name }
        }
      }
    }
    """
    r = gql(q2, auth=auth, key=key)

print(json.dumps(r.get('data', r), indent=2, ensure_ascii=False))
