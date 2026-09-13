const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__/

export function isMcpServerName(value: string): boolean {
  return MCP_SERVER_NAME.test(value)
}

export function mcpServerFromToolName(toolName: string): string | undefined {
  return MCP_TOOL_NAME.exec(toolName)?.[1]
}
