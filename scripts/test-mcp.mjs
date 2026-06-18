// Dev-only: spin up the GalacticBoard MCP server over stdio and exercise its tools end-to-end.
// Run: node scripts/test-mcp.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["mcp-server/index.mjs"],
  env: {
    ...process.env,
    GALACTICBOARD_URL: "http://localhost:3001",
    GALACTICBOARD_TOKEN: "gbk_JMaAity0wGuyp_eIAjeSQ6OQCor6SqOOKPzoyx17PO4",
  },
});

const client = new Client({ name: "mcp-smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const who = await client.callTool({ name: "whoami", arguments: {} });
console.log("WHOAMI:", who.content[0].text.slice(0, 200));

const created = await client.callTool({ name: "create_board", arguments: { title: "Made via MCP" } });
const board = JSON.parse(created.content[0].text).board;
console.log("CREATED BOARD:", board.id, board.title);

const node = await client.callTool({
  name: "add_node",
  arguments: { boardId: board.id, type: "text", data: { text: "# Hello from an AI agent" } },
});
console.log("ADDED NODE:", JSON.parse(node.content[0].text).node.id);

const full = await client.callTool({ name: "get_board", arguments: { boardId: board.id } });
const b = JSON.parse(full.content[0].text).board;
console.log("READBACK:", b.nodes.length, "node(s); first text =", JSON.stringify(b.nodes[0]?.data?.text));

await client.close();
console.log("MCP OK");
