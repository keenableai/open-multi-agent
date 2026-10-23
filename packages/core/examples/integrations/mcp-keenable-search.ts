/**
 * MCP Keenable Web Search
 *
 * Give a runTasks() research pipeline live web access through Keenable's
 * hosted MCP server, without a search API key. Two researchers share one MCP
 * connection and run in parallel, each searching the web
 * (`search_web_pages`) and reading pages (`fetch_page_content`) for one angle
 * of the topic. A writer task depends on both and turns their notes into a
 * short brief that cites the URLs the researchers read.
 *
 * Keenable serves MCP over Streamable HTTP at https://api.keenable.ai/mcp.
 * `connectMCPTools()` speaks stdio only, so the example launches the pinned
 * `@keenable/mcp` stdio bridge, which forwards every call to that endpoint.
 *
 * Run:
 *   npx tsx packages/core/examples/integrations/mcp-keenable-search.ts "<topic>"
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY (default provider). To use any other built-in
 *     provider, set OMA_PROVIDER and OMA_MODEL plus that provider's key, e.g.
 *     OMA_PROVIDER=deepseek OMA_MODEL=deepseek-flash DEEPSEEK_API_KEY=...
 *   - @modelcontextprotocol/sdk installed
 *   - npm can execute @keenable/mcp@0.1.1 from the public registry
 *
 * Optional env:
 *   KEENABLE_API_KEY  sent as X-API-Key to lift the keyless rate limit
 *                     (1,000 requests per hour per IP). Not needed to run.
 */

import { OpenMultiAgent, type SupportedProvider } from '../../src/index.js'
import { connectMCPTools } from '../../src/mcp.js'
import type { AgentConfig, OrchestratorEvent } from '../../src/types.js'

const TOPIC = process.argv[2] ?? 'the WebAssembly component model'
const provider = (process.env.OMA_PROVIDER ?? 'anthropic') as SupportedProvider
const model = process.env.OMA_MODEL ?? 'claude-sonnet-4-6'

const { tools, disconnect } = await connectMCPTools({
  command: 'npm',
  args: ['exec', '--yes', '--package', '@keenable/mcp@0.1.1', '--', 'keenable-mcp'],
  env: {
    // keenable_title labels the traffic as coming from this example.
    KEENABLE_MCP_URL: 'https://api.keenable.ai/mcp?keenable_title=open-multi-agent',
    KEENABLE_API_KEY: process.env.KEENABLE_API_KEY,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
  },
  namePrefix: 'keenable', // → keenable_search_web_pages, keenable_fetch_page_content
})

const RESEARCHER_PROMPT = [
  `You research one angle of a topic on the live web. Today is ${new Date().toISOString().slice(0, 10)}.`,
  'Search with keenable_search_web_pages, and read a page with keenable_fetch_page_content',
  'only when a search snippet is not enough.',
  'Reply with at most 5 bullets. End every bullet with the URL it came from.',
].join(' ')

// One MCP connection serves both researchers: customTools registers the tools
// for each agent (registration is the grant), and the writer gets none.
const researcher = (name: string): AgentConfig => ({
  name,
  provider,
  model,
  maxTurns: 6,
  customTools: tools,
  systemPrompt: RESEARCHER_PROMPT,
})

const writer: AgentConfig = {
  name: 'writer',
  provider,
  model,
  maxTurns: 1,
  systemPrompt: [
    'Write a brief of at most 200 words from the research notes you receive.',
    'Use only facts from the notes and keep their URLs as inline citations.',
  ].join(' '),
}

function handleProgress(event: OrchestratorEvent): void {
  if (event.type === 'agent_start') console.log(`[start] ${event.agent ?? ''}`)
  if (event.type === 'agent_complete') console.log(`[done]  ${event.agent ?? ''}`)
}

try {
  const orchestrator = new OpenMultiAgent({
    defaultProvider: provider,
    defaultModel: model,
    onProgress: handleProgress,
  })
  const team = orchestrator.createTeam('web-research', {
    name: 'web-research',
    agents: [researcher('news-researcher'), researcher('adoption-researcher'), writer],
    sharedMemory: true, // researcher output reaches the dependent writer task
  })

  console.log(`Topic: ${TOPIC}\nMCP tools: ${tools.map((tool) => tool.name).join(', ')}\n`)

  const result = await orchestrator.runTasks(team, [
    {
      title: 'Recent news',
      description: `Find what changed in the last six months for: ${TOPIC}. Releases, announcements, numbers.`,
      assignee: 'news-researcher',
    },
    {
      title: 'Adoption',
      description: `Find who uses ${TOPIC} in production today and the main criticism of it.`,
      assignee: 'adoption-researcher',
    },
    {
      title: 'Brief',
      description: `Write the brief on ${TOPIC} from the two research notes.`,
      assignee: 'writer',
      dependsOn: ['Recent news', 'Adoption'],
    },
  ])

  console.log(`\n${result.agentResults.get('writer')?.output ?? 'The writer produced no output.'}`)
  console.log(
    `\nsuccess=${result.success} tokens in=${result.totalTokenUsage.input_tokens} out=${result.totalTokenUsage.output_tokens}`,
  )
} finally {
  await disconnect()
}
