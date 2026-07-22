"""Fetch get_content_type_key for a couple of events to confirm URL pattern."""
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

rt = gql(
    'mutation R($rt:String!){refresh_token(refresh_token:$rt,revoke_refresh_token:false){success token{token}}}',
    {'rt': os.environ['SSI_REFRESH_TOKEN']}
)
jwt = rt['data']['refresh_token']['token']['token']

q = """
query {
  events(starts_after: "2026-07-22", starts_before: "2026-07-25") {
    ... on EventInterface {
      id name get_content_type_key url
    }
  }
}
"""
r = gql(q, auth=f'JWT {jwt}', key=os.environ['SSI_API_KEY'])
for e in (r.get('data') or {}).get('events', []):
    print(f"id={e['id']}  ctype={e['get_content_type_key']}  url={e['url']!r}  name={e['name'][:40]}")
