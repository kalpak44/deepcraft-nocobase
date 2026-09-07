#!/usr/bin/env python3
"""Register docs-mcp with NocoBase and create the AI employee that uses it.

Runs *on the box*, against the app on loopback, and reads the root credentials
out of the application's own .env — so nothing has to carry a password over the
wire or keep a second copy of it in sync.

Idempotent by design, because it is the only way to apply a changed prompt: it
creates the MCP client row and the employee if they are missing and updates them
in place if they are already there. Run it as often as you like.

Everything it needs is standard library — the box has python3 and no pip
packages, and this is not worth changing that for.

Usage:
    register-docs-employee.py <prompt-file>

Environment:
    DOCS_EMPLOYEE_USERNAME   default "dora"
    DOCS_EMPLOYEE_NICKNAME   default "Dora"
    DOCS_MCP_NAME            MCP client row name, default "docs-mcp"
    DOCS_MCP_URL             default http://127.0.0.1:8812/mcp
    DOCS_LLM_SERVICE         llmServices row name; default is the first enabled one
    DOCS_LLM_MODEL           default is the service's first enabled model
    NOCOBASE_APP_ENV         path to the app .env, default /data/nocobase/app/.env
    NOCOBASE_API             default http://127.0.0.1:13000/api/
"""

import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get('NOCOBASE_API', 'http://127.0.0.1:13000/api/')
APP_ENV = os.environ.get('NOCOBASE_APP_ENV', '/data/nocobase/app/.env')

MCP_NAME = os.environ.get('DOCS_MCP_NAME', 'docs-mcp')
MCP_URL = os.environ.get('DOCS_MCP_URL', 'http://127.0.0.1:8812/mcp')
USERNAME = os.environ.get('DOCS_EMPLOYEE_USERNAME', 'dora')
NICKNAME = os.environ.get('DOCS_EMPLOYEE_NICKNAME', 'Dora')

# Read tools first: they are the ones NocoBase auto-calls, because their names
# start with "get". The two write tools are listed with autoCall false to record
# the intent -- MCP tools register with scope GENERAL, where autoCall is not
# consulted at all, so what actually makes them prompt is the name not starting
# with "get". See .claude/rules/nocobase.md and the note atop server.js.
READ_TOOLS = ['get_document_search', 'get_document_text', 'get_documents']
WRITE_TOOLS = ['write_document', 'edit_document']


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
        req = urllib.request.Request(API + path, method=method or ('POST' if body is not None else 'GET'))
        req.add_header('Content-Type', 'application/json')
        # Without this, resolving the date variables in a system prompt dies
        # with a bare "m.startOf is not a function" -- see the rules file. It
        # costs nothing to send on every call rather than remembering which
        # ones need it.
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
    """Choose the LLM service and model to bind the employee to.

    Not hardcoded: the service row name is a generated id, different in every
    installation, and an employee without a working modelSettings looks
    configured and simply cannot answer.
    """
    service = os.environ.get('DOCS_LLM_SERVICE')
    model = os.environ.get('DOCS_LLM_MODEL')

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

    if not model:
        models = (row.get('enabledModels') or {}).get('models') or []
        if models:
            model = models[0].get('value')
        else:
            listed = api(f'ai:listModels?llmService={row["name"]}').get('data', [])
            if not listed:
                raise SystemExit(f'{row["name"]} exposes no models — check its API key in NocoBase')
            model = listed[0]['id']

    return row, model


def upsert(api, resource, key, values, label):
    existing = api.get_or_none(f'{resource}:get?filterByTk={key}')
    if existing:
        api(f'{resource}:update?filterByTk={key}', values)
        print(f'  updated {label}')
        return 'updated'
    api(f'{resource}:create', dict(values, **{'name' if resource == 'aiMcpClients' else 'username': key}))
    print(f'  created {label}')
    return 'created'


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

    print(f'MCP client "{MCP_NAME}" -> {MCP_URL}')
    # transport "http" means streamable HTTP, which is what /mcp speaks. "sse"
    # is the older protocol and would not connect.
    upsert(api, 'aiMcpClients', MCP_NAME, {
        'transport': 'http', 'url': MCP_URL, 'enabled': True
    }, f'aiMcpClients row "{MCP_NAME}"')

    # An updated URL does not take effect until the client is rebuilt.
    api(f'aiMcpClients:rebuildClient?filterByTk={MCP_NAME}', {})
    print('  rebuilt the client')

    # listTools returns every configured server, keyed by name, and ignores
    # filterByTk — so pick our own out of the mapping rather than trusting the
    # filter.
    listed = api('aiMcpClients:listTools').get('data') or {}
    tools = {t['name']: t for t in listed.get(MCP_NAME, [])}
    if not tools:
        raise SystemExit(
            f'{MCP_NAME} reported no tools. Is docs-mcp.service running on {MCP_URL}? '
            'Check: just docs-status'
        )

    # The names are mcp-<server>-<tool>. Verifying them against what the server
    # actually reports means a renamed tool fails here, loudly, instead of
    # becoming an employee with a skill it cannot invoke.
    wanted = [f'mcp-{MCP_NAME}-{t}' for t in READ_TOOLS + WRITE_TOOLS]
    missing = [full for full in wanted if full not in tools]
    if missing:
        raise SystemExit(
            f'{MCP_NAME} did not report these tools: ' + ', '.join(missing) +
            f'\nIt reported: {", ".join(sorted(tools))}'
        )

    # NocoBase decides each tool's default permission from its raw name: ASK
    # unless the name starts with "get". Printing it is how you confirm the read
    # tools will auto-call and the write tools will keep prompting — and it is
    # in-memory only, so this is the state after every restart.
    print(f'  {len(tools)} tools reported:')
    for full in wanted:
        raw = full[len(f'mcp-{MCP_NAME}-') :]
        perm = tools[full].get('permission', '?')
        print(f'    {raw:24} {perm}{"" if raw.startswith("get") else "   <- confirms before running"}')
    surprising = [
        f[len(f'mcp-{MCP_NAME}-'):] for f in wanted
        if (tools[f].get('permission') == 'ASK') != (not f[len(f'mcp-{MCP_NAME}-'):].startswith('get'))
    ]
    if surprising:
        print(
            '  WARNING: permissions are not what the tool names imply for: '
            + ', '.join(surprising)
        )

    service, model = pick_model(api)
    print(f'model: {model} via llmServices "{service["name"]}" ({service.get("title")})')

    print(f'employee "{USERNAME}"')
    upsert(api, 'aiEmployees', USERNAME, {
        'nickname': NICKNAME,
        'position': 'Document specialist for the shared file library',
        'bio': (
            f"I'm {NICKNAME}. I search, read and write the documents on the team's shared "
            'file library — PDFs, Word documents, spreadsheets and presentations.'
        ),
        'greeting': (
            f"Hi, I'm {NICKNAME}. Ask me what's in the shared documents, or ask me to draft "
            'one. I can read PDFs, Word, Excel and PowerPoint, and I always tell you which '
            'file an answer came from.'
        ),
        # The prompt goes in `about`, not `defaultPrompt`.
        'about': prompt,
        'avatar': 'nocobase-005-female',
        'category': 'business',
        'enabled': True,
        'modelSettings': {'enabled': True, 'models': [
            {'llmService': service['name'], 'model': model}
        ]},
        'skillSettings': {'skills': [], 'tools': (
            [{'name': f'mcp-{MCP_NAME}-{t}', 'autoCall': True} for t in READ_TOOLS] +
            [{'name': f'mcp-{MCP_NAME}-{t}', 'autoCall': False} for t in WRITE_TOOLS]
        )},
        # No knowledge-base plugin on this installation; the MCP tools are the
        # retrieval path.
        'enableKnowledgeBase': False,
    }, f'aiEmployees row "{USERNAME}"')

    print(
        f'\n{NICKNAME} is ready. The three get_* tools auto-call; write_document and '
        'edit_document will ask for confirmation every time, including after a restart of '
        'nocobase.service.'
    )


if __name__ == '__main__':
    main()