#!/usr/bin/env python3
"""Create or refresh the Transcriber AI employee and bind it to whisper.

Runs *on the box*, against the app on loopback, and reads the root credentials
out of the application's own .env — same shape as register-docs-employee.py, so
nothing carries a password over the wire.

Idempotent by design, and re-running it is how a changed employee-prompt.md gets
applied.

What was wrong
--------------
The employee predates whisper. It was built around an audio-capable chat model
and its configuration still said so, in three ways that each broke it:

- `modelSettings` named an `llmServices` row called "openai-transcriber" that
  does not exist on this installation. Per .claude/rules/nocobase.md an employee
  whose modelSettings name a missing service looks configured and simply cannot
  answer.
- `skillSettings.tools` was empty, so even with a working model it had no way
  to transcribe anything.
- The prompt told it to "listen to the entire file" and to label speakers as
  Speaker 1 / Speaker 2. It cannot listen — whisper does — and whisper-server
  returns plain text with no diarisation, so the speaker instruction was asking
  it to invent attributions.

Nothing used it, which is why none of that ever surfaced as an error.

Picking the model
-----------------
The `llmServices` row name is a generated id that differs per installation, so
it is looked up, never hardcoded. The model is subtler: `ai:listModels` is
**not** authoritative here. On this box it reports `deepseek-flash` and
`deepseek-v4-pro`, while every working employee runs `deepseek-v4-flash`, which
the provider still serves and the listing omits. So the default is whatever
model the other employees on that service already use — observed-good beats
advertised — and the listing is only a fallback.

Usage:
    register-transcriber-employee.py <prompt-file>

Environment:
    TRANSCRIBER_USERNAME     default "transcriber"
    TRANSCRIBER_NICKNAME     default "Transcriber"
    TRANSCRIBER_LLM_SERVICE  llmServices row name; default the enabled one
    TRANSCRIBER_LLM_MODEL    default as described above
    NOCOBASE_APP_ENV         path to the app .env, default /data/nocobase/app/.env
    NOCOBASE_API             default http://127.0.0.1:13000/api/
"""

import collections
import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get('NOCOBASE_API', 'http://127.0.0.1:13000/api/')
APP_ENV = os.environ.get('NOCOBASE_APP_ENV', '/data/nocobase/app/.env')

USERNAME = os.environ.get('TRANSCRIBER_USERNAME', 'transcriber')
NICKNAME = os.environ.get('TRANSCRIBER_NICKNAME', 'Transcriber')

# Registered by @deepcraft/plugin-transcribe, not by an MCP server — so the name
# is bare, with none of the mcp-<server>- prefixing that Dora's and Lexy's tools
# carry. It registers with defaultPermission ALLOW, which is what lets the
# employee call it without stopping to ask first.
TOOL = 'transcribeAudio'


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
        # See .claude/rules/nocobase.md — without this, resolving the date
        # variables in a system prompt dies with "m.startOf is not a function"
        # before the model is ever called.
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

    def get_or_none(self, path):
        try:
            return self(path).get('data')
        except SystemExit:
            return None


def pick_model(api):
    """Choose the llmServices row and model to bind the employee to."""
    service = os.environ.get('TRANSCRIBER_LLM_SERVICE')
    model = os.environ.get('TRANSCRIBER_LLM_MODEL')

    services = api('llmServices:list?pageSize=50').get('data', [])
    enabled = [s for s in services if s.get('enabled')] or services
    if not enabled:
        raise SystemExit(
            'no llmServices row exists — add an LLM provider in NocoBase first, '
            'or the employee will look configured and be unable to answer'
        )

    if service:
        match = [s for s in enabled if s['name'] == service or s.get('title') == service]
        if not match:
            names = ', '.join(f'{s["name"]} ({s.get("title")})' for s in enabled)
            raise SystemExit(f'no such llmServices row: {service}. Available: {names}')
        row = match[0]
    else:
        row = enabled[0]

    if model:
        return row, model

    # What the other employees on this service actually run. See the module
    # docstring: the provider still serves model ids that ai:listModels has
    # stopped advertising, so a working sibling is better evidence than the
    # listing is.
    votes = collections.Counter()
    for emp in api('aiEmployees:list?pageSize=100').get('data', []):
        settings = emp.get('modelSettings') or {}
        if not settings.get('enabled'):
            continue
        for entry in settings.get('models') or []:
            if entry.get('llmService') == row['name'] and entry.get('model'):
                votes[entry['model']] += 1
    if votes:
        return row, votes.most_common(1)[0][0]

    listed = api(f'ai:listModels?llmService={row["name"]}').get('data', [])
    if not listed:
        raise SystemExit(f'{row["name"]} exposes no models — check its API key in NocoBase')
    return row, listed[0]['id']


def tool_is_registered(api):
    """Confirm the plugin actually registered the tool before binding to it.

    Binding a name the tool manager has never heard of produces an employee that
    looks equipped and fails the moment it tries to transcribe, which is exactly
    the failure mode this script exists to end.
    """
    for tool in api('aiTools:list?pageSize=300').get('data', []):
        if ((tool.get('definition') or {}).get('name')) == TOOL:
            return tool
    return None


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    prompt = open(sys.argv[1], encoding='utf-8').read().strip()
    if not prompt:
        raise SystemExit(f'{sys.argv[1]} is empty — refusing to give the employee no instructions')

    env = app_env(APP_ENV)
    api = Api()
    api.token = api('auth:signIn', {
        'email': env['INIT_ROOT_EMAIL'], 'password': env['INIT_ROOT_PASSWORD']
    })['data']['token']

    tool = tool_is_registered(api)
    if not tool:
        raise SystemExit(
            f'the AI tool manager does not know "{TOOL}". Is @deepcraft/plugin-transcribe '
            'enabled? Check: journalctl -u nocobase | grep noco-transcribe'
        )
    print(f'tool "{TOOL}" registered, defaultPermission={tool.get("defaultPermission")}')

    service, model = pick_model(api)
    print(f'model: {model} via llmServices "{service["name"]}" ({service.get("title")})')

    values = {
        'nickname': NICKNAME,
        'position': 'Meeting recording transcriber',
        'bio': (
            f"I'm {NICKNAME}. I turn an audio recording into a written transcript using "
            "this machine's own speech-to-text, so the audio never leaves the box."
        ),
        'greeting': (
            f"Hi, I'm {NICKNAME}. Give me a recording and I'll transcribe it verbatim, in "
            'whatever language is spoken. It runs on local CPU, so expect about a minute '
            'and a half of work for every thirty seconds of audio.'
        ),
        # The prompt is `about`, not `defaultPrompt` — see the rules file.
        'about': prompt,
        'modelSettings': {
            'enabled': True,
            'models': [{'llmService': service['name'], 'model': model}],
        },
        'skillSettings': {'tools': [{'name': TOOL, 'autoCall': True}], 'skills': []},
    }

    existing = api.get_or_none(f'aiEmployees:get?filterByTk={USERNAME}')
    if existing:
        api(f'aiEmployees:update?filterByTk={USERNAME}', values)
        print(f'employee "{USERNAME}" updated')
    else:
        api('aiEmployees:create', dict(values, username=USERNAME))
        print(f'employee "{USERNAME}" created')

    # Read it back rather than trusting the write: a silently dropped
    # modelSettings or skillSettings is the whole failure this replaces.
    after = api(f'aiEmployees:get?filterByTk={USERNAME}').get('data') or {}
    bound = [t.get('name') for t in ((after.get('skillSettings') or {}).get('tools') or [])]
    models = (after.get('modelSettings') or {}).get('models') or []
    if TOOL not in bound:
        raise SystemExit(f'{USERNAME} came back without {TOOL} bound: {bound}')
    if not any(m.get('llmService') == service['name'] and m.get('model') == model for m in models):
        raise SystemExit(f'{USERNAME} came back with unexpected modelSettings: {models}')
    if (after.get('about') or '').strip() != prompt:
        raise SystemExit(f'{USERNAME} came back with a prompt that is not the one just sent')
    print(f'verified: {USERNAME} runs {model} and can call {TOOL}')


if __name__ == '__main__':
    sys.exit(main())
