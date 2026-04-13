/**
 * Provider-neutral tool definition types and format mappers.
 * Used by the AgenticLoop to define tools for Claude API tool_use.
 */

// ─── Provider-Neutral Types ──────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export type ToolHandlerMap = Record<string, ToolHandler>;

// ─── Anthropic Format ────────────────────────────

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[] | AnthropicToolResultBlock[];
}

export interface AnthropicResponse {
  id: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage?: { input_tokens?: number; output_tokens?: number };
}

// ─── Mappers ─────────────────────────────────────

export function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      ...t.inputSchema,
    },
  }));
}

/** Extract tool_use blocks from an Anthropic response */
export function extractToolUseBlocks(content: AnthropicContentBlock[]): AnthropicToolUseBlock[] {
  return content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');
}

/** Extract text from an Anthropic response */
export function extractText(content: AnthropicContentBlock[]): string {
  return content
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
