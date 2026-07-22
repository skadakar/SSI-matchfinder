import json
from urllib.request import urlopen, Request

GQL = 'https://shootnscoreit.com/graphql/'

def probe(type_name):
    q = json.dumps({'query': '{ __type(name: "%s") { fields { name type { name kind ofType { name kind } } } } }' % type_name}).encode()
    req = Request(GQL, data=q, headers={'Content-Type': 'application/json'})
    with urlopen(req, timeout=15) as r:
        d = json.loads(r.read())
    t = (d.get('data') or {}).get('__type')
    if not t:
        print(f'{type_name}: not found')
        return
    print(f'\n{type_name}:')
    for f in t.get('fields', []):
        ft = f['type']
        print(f'  {f["name"]} -> {ft.get("name") or ft.get("kind")}  {ft.get("ofType") or ""}')

for t in ['ObtainJSONWebTokenType', 'TokenType', 'RefreshTokenType']:
    probe(t)
