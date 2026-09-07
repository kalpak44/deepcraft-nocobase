#!/usr/bin/env python3
"""Register lex-mcp with NocoBase and create or refresh the Lexy AI employee.

Runs *on the box*, against the app on loopback, and reads the root credentials
out of the application's own .env — so nothing has to carry a password over the
wire or keep a second copy of it in sync.

Idempotent by design, because it is the only way to apply a changed prompt: it
creates the MCP client row and the employee if they are missing and updates them
in place if they are already there. Run it as often as you like.

It deliberately does *not* overwrite an employee's existing model binding. Lexy
predates this script on installations that already had her, with a model someone
chose in the UI; picking "the first enabled service" on every run would quietly
move her onto a different model. Set LEXY_LLM_SERVICE/LEXY_LLM_MODEL to change
it on purpose.

Everything it needs is standard library — the box has python3 and no pip
packages, and this is not worth changing that for.

Usage:
    register-lexy-employee.py <prompt-file>

Environment:
    LEXY_EMPLOYEE_USERNAME   default "lexy"
    LEXY_EMPLOYEE_NICKNAME   default "Lexy"
    LEX_MCP_NAME             MCP client row name, default "lex-mcp"
    LEX_MCP_URL              default http://127.0.0.1:8814/mcp
    LEXY_LLM_SERVICE         llmServices row name; default is to keep whatever
                             the employee already has, else the first enabled one
    LEXY_LLM_MODEL           default as above
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

MCP_NAME = os.environ.get('LEX_MCP_NAME', 'lex-mcp')
MCP_URL = os.environ.get('LEX_MCP_URL', 'http://127.0.0.1:8814/mcp')
USERNAME = os.environ.get('LEXY_EMPLOYEE_USERNAME', 'lexy')
NICKNAME = os.environ.get('LEXY_EMPLOYEE_NICKNAME', 'Lexy')

# Every tool lex-mcp exposes, and every one of them starts with "get" on
# purpose: NocoBase reads an MCP tool's permission off its raw name and only
# auto-calls the get_* ones. See mcp_servers/lex-mcp/server.js and
# .claude/rules/nocobase.md. There are no ASK tools in this set because none of
# these change anything — the browser only ever reads lex.bg.
TOOLS = [
    'get_lex_open',
    'get_lex_page_text',
    'get_lex_search',
    'get_lex_snapshot',
    'get_lex_click',
    'get_lex_type',
    'get_lex_back',
    'get_browser_status',
]


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


def pick_model(api, existing):
    """Choose the LLM service and model to bind the employee to.

    Keeps what the employee already has unless told otherwise: the service row
    name is a generated id, different in every installation, and an employee
    without a working modelSettings looks configured and simply cannot answer.
    """
    service_name = os.environ.get('LEXY_LLM_SERVICE')
    model_name = os.environ.get('LEXY_LLM_MODEL')

    if not service_name and not model_name:
        current = ((existing or {}).get('modelSettings') or {}).get('models') or []
        if current and current[0].get('llmService') and current[0].get('model'):
            print(f'model: keeping {current[0]["model"]} via "{current[0]["llmService"]}"')
            return None  # signals "do not touch modelSettings"

    services = api('llmServices:list?pageSize=50').get('data', [])
    enabled = [s for s in services if s.get('enabled')] or services
    if not enabled:
        raise SystemExit(
            'no llmServices row exists — add an LLM provider in NocoBase first, '
            'or the employee will look configured and be unable to answer'
        )

    if service_name:
        match = [s for s in enabled if s['name'] == service_name or s.get('title') == service_name]
        if not match:
            names = ', '.join(f'{s["name"]} ({s.get("title")})' for s in enabled)
            raise SystemExit(f'no such llmServices row: {service_name}. Available: {names}')
        row = match[0]
    else:
        row = enabled[0]

    if not model_name:
        models = (row.get('enabledModels') or {}).get('models') or []
        if models:
            model_name = models[0].get('value')
        else:
            listed = api(f'ai:listModels?llmService={row["name"]}').get('data', [])
            if not listed:
                raise SystemExit(f'{row["name"]} exposes no models — check its API key in NocoBase')
            model_name = listed[0]['id']

    print(f'model: {model_name} via llmServices "{row["name"]}" ({row.get("title")})')
    return {'enabled': True, 'models': [{'llmService': row['name'], 'model': model_name}]}


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
    existing_client = api.get_or_none(f'aiMcpClients:get?filterByTk={MCP_NAME}')
    values = {'transport': 'http', 'url': MCP_URL, 'enabled': True}
    if existing_client:
        api(f'aiMcpClients:update?filterByTk={MCP_NAME}', values)
        print(f'  updated aiMcpClients row "{MCP_NAME}"')
    else:
        api('aiMcpClients:create', dict(values, name=MCP_NAME))
        print(f'  created aiMcpClients row "{MCP_NAME}"')

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
            f'{MCP_NAME} reported no tools. Is lex-mcp.service running on {MCP_URL}? '
            'Check: just lexy-status'
        )

    # The names are mcp-<server>-<tool>. Verifying them against what the server
    # actually reports means a renamed tool fails here, loudly, instead of
    # becoming an employee with a skill it cannot invoke.
    wanted = [f'mcp-{MCP_NAME}-{t}' for t in TOOLS]
    missing = [full for full in wanted if full not in tools]
    if missing:
        raise SystemExit(
            f'{MCP_NAME} did not report these tools: ' + ', '.join(missing) +
            f'\nIt reported: {", ".join(sorted(tools))}'
        )

    # NocoBase decides each tool's default permission from its raw name: ASK
    # unless the name starts with "get". Printing it is the cheapest way to
    # confirm the whole reason lex-mcp exists is working — every one of these
    # must say ALLOW, or Lexy will stop to ask on every single page load. It is
    # in-memory only, so this is also the state after every restart.
    print(f'  {len(tools)} tools reported:')
    asking = []
    for full in wanted:
        raw = full[len(f'mcp-{MCP_NAME}-'):]
        perm = tools[full].get('permission', '?')
        print(f'    {raw:20} {perm}')
        if perm != 'ALLOW':
            asking.append(raw)
    if asking:
        raise SystemExit(
            '\nThese tools came back as ' + ', '.join(asking) +
            ' rather than ALLOW, which means Lexy will ask for confirmation before '
            'every page load. Every tool lex-mcp exposes has to start with "get" — '
            'see the comment at the top of mcp_servers/lex-mcp/server.js.'
        )

    existing = api.get_or_none(f'aiEmployees:get?filterByTk={USERNAME}')
    model_settings = pick_model(api, existing)

    print(f'employee "{USERNAME}"')
    values = {
        'nickname': NICKNAME,
        'position': 'Law Researcher',
        'bio': (
            f"I'm {NICKNAME}, your law research analyst. I read Bulgarian legislation "
            'directly from Lex.bg (лекс) in a real browser, so I can quote the current text '
            'of an act rather than describing it from memory.'
        ),
        'greeting': (
            f"Hi, I'm {NICKNAME}. Ask me what Bulgarian law says about something and I'll "
            'find the act on lex.bg and quote the article, with a link. If the site ever '
            'puts up a human-verification check, I\'ll ask you to click it for me.'
        ),
        # The prompt goes in `about`, not `defaultPrompt`.
        'about': prompt,
        'avatar': (existing or {}).get('avatar') or 'nocobase-043-male',
        'category': 'business',
        'enabled': True,
        # Every tool is a read of a public website, so all of them auto-call.
        'skillSettings': {
            'skills': [],
            'tools': [{'name': f'mcp-{MCP_NAME}-{t}', 'autoCall': True} for t in TOOLS],
        },
        # No knowledge-base plugin on this installation; the MCP tools are the
        # retrieval path.
        'enableKnowledgeBase': False,
    }
    if model_settings is not None:
        values['modelSettings'] = model_settings

    if existing:
        api(f'aiEmployees:update?filterByTk={USERNAME}', values)
        print(f'  updated aiEmployees row "{USERNAME}"')
    else:
        api('aiEmployees:create', dict(values, username=USERNAME))
        print(f'  created aiEmployees row "{USERNAME}"')

    print(
        f'\n{NICKNAME} is ready. All {len(TOOLS)} tools auto-call, so she researches without '
        'stopping to ask — including after a restart of nocobase.service. When Cloudflare '
        'wants a human she will hand the user the takeover URL and wait.'
    )


if __name__ == '__main__':
    main()