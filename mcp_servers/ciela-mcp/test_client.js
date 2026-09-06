import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'test-client', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8811/mcp'));

await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', JSON.stringify(tools, null, 2));

const searchResult = await client.callTool({
  name: 'ciela_search',
  arguments: { query: 'РАЗПОРЕЖДАНЕ ОТ 15.01.2026 Г. ЗА ОБРАЗУВАНЕ НА ТЪЛК. Д. № 1/2026 Г., ОСГК НА ВКС', limit: 5 }
});
console.log('SEARCH RESULT:', JSON.stringify(searchResult, null, 2).slice(0, 2000));

const parsed = JSON.parse(searchResult.content[0].text);
const top = parsed.results[0];
console.log('TOP RESULT:', top.title, top.score);

const docResult = await client.callTool({
  name: 'ciela_get_document',
  arguments: { contentHref: top.contentHref }
});
const docParsed = JSON.parse(docResult.content[0].text);
console.log('DOC TITLE:', docParsed.title);
console.log('DOC TEXT PREVIEW:', docParsed.text.slice(0, 500));

process.exit(0);
