#!/usr/bin/env python3
"""Mint the API key the transcription workflow authenticates with, and store it.

Runs *on the box*, against the app on loopback, and reads the root credentials
out of the application's own .env — same shape as register-docs-employee.py, so
nothing carries a password over the wire.

The token is never printed, logged or written to disk. It goes straight from
`apiKeys:create` into the `transcription_workflow_api_key` environment variable,
which NocoBase stores encrypted because its type is `secret`.

Why this exists
---------------
The workflow's "Call transcription API" node sends
`Authorization: Bearer {{$env.transcription_workflow_api_key}}`. That credential
had stopped working, and the way it failed is worth knowing:

    401 {"code": "INVALID_TOKEN",
         "message": "Your session has expired. Please sign in again."}

It had **not** expired. The apiKeys row behind it was created with 364d and had
nearly a year left. The journal says what actually happened:

    {"level":"error","message":{"name":"JsonWebTokenError",
     "message":"invalid signature"},"extra":{"method":"jwt.decode"}}

`APP_KEY` had been rotated, so every token ever signed with the old one became
unverifiable. `@nocobase/auth` reports a bad signature and a real expiry through
the same 401 and the same "session has expired" sentence, so the symptom points
at the wrong cause. The apiKeys *row* survives a rotation and keeps looking
healthy in the UI; only the token it holds is dead.

Rotating is therefore the fix for both causes, which is why this does not try to
tell them apart: it replaces the key unconditionally and proves the new one
works before storing it. Same semantics as `just webdav-user-add` — running it
again resets the credential rather than reporting "nothing to do".

An API key is not subject to NocoBase's session policy. `@nocobase/auth` only
applies `sessionExpirationTime` / `tokenExpirationTime` to tokens carrying
`temp`, which API keys do not; they are accepted on JWT validity alone. So the
expiry set here is the whole story.

Usage:
    rotate-transcription-token.py

Environment:
    TRANSCRIPTION_TOKEN_NAME    apiKeys row name, default "Transcription Workflow"
    TRANSCRIPTION_TOKEN_ROLE    default "member" — the endpoint only requires a
                                logged-in user, so it does not need admin
    TRANSCRIPTION_TOKEN_EXPIRY  default "3650d"
    TRANSCRIPTION_TOKEN_VAR     env var to store it in,
                                default "transcription_workflow_api_key"
    NOCOBASE_APP_ENV            path to the app .env, default /data/nocobase/app/.env
    NOCOBASE_API                default http://127.0.0.1:13000/api/
"""

import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get('NOCOBASE_API', 'http://127.0.0.1:13000/api/')
APP_ENV = os.environ.get('NOCOBASE_APP_ENV', '/data/nocobase/app/.env')

KEY_NAME = os.environ.get('TRANSCRIPTION_TOKEN_NAME', 'Transcription Workflow')
ROLE = os.environ.get('TRANSCRIPTION_TOKEN_ROLE', 'member')
EXPIRY = os.environ.get('TRANSCRIPTION_TOKEN_EXPIRY', '3650d')
VAR_NAME = os.environ.get('TRANSCRIPTION_TOKEN_VAR', 'transcription_workflow_api_key')


def app_env(path):
    """Parse the application's .env without a shell.

    Deliberately not `source`d: the values are raw and unquoted, and the root
    password on this installation contains characters a shell would mangle or
    execute.
    """
    out = {}
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                out[key.strip()] = value.strip()
    return out


class Api:
    def __init__(self, token=None):
        self.token = token

    def __call__(self, path, body=None, method=None):
        req = urllib.request.Request(
            API + path, method=method or ('POST' if body is not None else 'GET')
        )
        req.add_header('Content-Type', 'application/json')
        req.add_header('X-Timezone', '+00:00')
        if self.token:
            req.add_header('Authorization', 'Bearer ' + self.token)
        data = json.dumps(body).encode() if body is not None else None
        try:
            with urllib.request.urlopen(req, data, timeout=120) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            detail = err.read().decode('utf-8', 'replace')[:400]
            raise SystemExit(f'{method or "GET"} {path} failed: {err.code} {detail}')
        except urllib.error.URLError as err:
            raise SystemExit(f'{path} unreachable: {err.reason} — is nocobase.service running?')


def main():
    env = app_env(APP_ENV)
    api = Api()
    api.token = api('auth:signIn', {
        'email': env['INIT_ROOT_EMAIL'], 'password': env['INIT_ROOT_PASSWORD']
    })['data']['token']

    me = api('auth:check')['data']
    username = me['username']

    # Drop every previous row with this name first, so one name never maps to
    # several credentials and the dead pre-rotation one cannot be mistaken for
    # the live one.
    stale = [k for k in api('apiKeys:list?pageSize=200').get('data', [])
             if k.get('name') == KEY_NAME]
    for row in stale:
        api(f'apiKeys:destroy?filterByTk={row["id"]}', {}, method='POST')
        print(f'removed previous key id={row["id"]} (created {row.get("createdAt")})')

    # The POST body *is* `values` for a collection create — wrapping these in a
    # {"values": ...} envelope nests them one level too deep, and the action
    # then reads `values.role` as undefined and returns an empty 200 without
    # creating anything. `role` is an object, not a string, for the same reason:
    # it reads `values.role.name`.
    created = api('apiKeys:create',
                  {'name': KEY_NAME, 'role': {'name': ROLE}, 'expiresIn': EXPIRY})
    token = created.get('token') or (created.get('data') or {}).get('token')
    if not token:
        raise SystemExit(f'apiKeys:create returned no token: {json.dumps(created)[:300]}')
    print(f'minted "{KEY_NAME}" for {username} as role {ROLE}, expires in {EXPIRY}')

    # Prove it before storing it. A key that cannot call the endpoint the
    # workflow calls is worse than no key, because it fails inside a workflow
    # run rather than here.
    probe = Api(token)
    status = probe('transcription:configStatus')
    provider = (status.get('data') or {}).get('defaultProvider')
    if not provider:
        raise SystemExit(f'the new key could not read transcription:configStatus: '
                         f'{json.dumps(status)[:300]}')
    print(f'verified: the new key can call transcription:* (provider {provider})')

    rows = api('environmentVariables:list?pageSize=200').get('data', [])
    row = next((v for v in rows if v.get('name') == VAR_NAME), None)
    if row:
        api(f'environmentVariables:update?filterByTk={row.get("id", VAR_NAME)}',
            {'value': token, 'type': 'secret'})
        print(f'stored it in environment variable "{VAR_NAME}" (updated)')
    else:
        api('environmentVariables:create',
            {'name': VAR_NAME, 'type': 'secret', 'value': token})
        print(f'stored it in environment variable "{VAR_NAME}" (created)')

    # The value is write-only over the API once stored, so confirm presence and
    # type rather than reading the secret back.
    after = next((v for v in api('environmentVariables:list?pageSize=200').get('data', [])
                  if v.get('name') == VAR_NAME), None)
    if not after:
        raise SystemExit(f'{VAR_NAME} is not present after writing it')
    print(f'{VAR_NAME} present, type={after.get("type")}')
    print('the workflow will pick it up on its next run; nothing needs restarting')


if __name__ == '__main__':
    sys.exit(main())
