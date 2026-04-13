/**
 * AgenticLoop — Tool-use execution loop for Claude API.
 *
 * Calls Claude with tools → if stop_reason is "tool_use", executes the tool
 * handler → sends tool_result back → repeats until "end_turn" or max iterations.
 */
import { logger } from '../../lib/logger.js';
import type {
  ToolDefinition,
  ToolHandlerMap,
  AnthropicToolResultBlock,
  AnthropicMessage,
  AnthropicResponse,
} from '../../services/ai/tool-schemas.js';
import { extractToolUseBlocks, extractText } from '../../services/ai/tool-schemas.js';

export interface AgenticLoopDeps {
  /** Calls Claude API with tools and returns raw response */
  callWithTools(
    messages: AnthropicMessage[],
    tools: ToolDefinition[],
    options?: { model?: string; maxTokens?: number; temperature?: number; system?: string },
  ): Promise<AnthropicResponse>;
}

export interface AgenticLoopOptions {
  maxIterations?: number;
  onToolCall?: (toolName: string, input: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: unknown, isError: boolean) => void;
}

export interface AgenticLoopResult {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: unknown }>;
  iterations: number;
  totalUsage: { inputTokens: number; outputTokens: number };
}

const DEFAULT_MAX_ITERATIONS = 15;

export async function runAgenticLoop(
  deps: AgenticLoopDeps,
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDefinition[],
  handlers: ToolHandlerMap,
  options: AgenticLoopOptions & { model?: string; maxTokens?: number; temperature?: number } = {},
): Promise<AgenticLoopResult> {
  const maxIter = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const toolCalls: AgenticLoopResult['toolCalls'] = [];
  const totalUsage = { inputTokens: 0, outputTokens: 0 };

  // Build initial messages
  const messages: AnthropicMessage[] = [
    { role: 'user', content: userPrompt },
  ];

  let lastText = '';

  for (let i = 0; i < maxIter; i++) {
    const response = await deps.callWithTools(messages, tools, {
      model: options.model,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      system: systemPrompt,
    });

    // Accumulate usage
    if (response.usage) {
      totalUsage.inputTokens += response.usage.input_tokens ?? 0;
      totalUsage.outputTokens += response.usage.output_tokens ?? 0;
    }

    // Extract text from this turn
    const turnText = extractText(response.content);
    if (turnText) lastText = turnText;

    // Check stop reason
    if (response.stop_reason !== 'tool_use') {
      return { text: lastText, toolCalls, iterations: i + 1, totalUsage };
    }

    // Execute tool calls
    const toolUseBlocks = extractToolUseBlocks(response.content);
    if (toolUseBlocks.length === 0) {
      return { text: lastText, toolCalls, iterations: i + 1, totalUsage };
    }

    // Add assistant's response (with tool_use blocks) to messages
    messages.push({ role: 'assistant', content: response.content });

    // Execute each tool and collect results
    const toolResults: AnthropicToolResultBlock[] = [];
    for (const block of toolUseBlocks) {
      options.onToolCall?.(block.name, block.input);

      const handler = handlers[block.name];
      if (!handler) {
        const errMsg = `Unknown tool: ${block.name}`;
        logger.warn(`[AgenticLoop] ${errMsg}`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: errMsg, is_error: true });
        toolCalls.push({ name: block.name, input: block.input, result: errMsg });
        options.onToolResult?.(block.name, errMsg, true);
        continue;
      }

      try {
        const result = await handler(block.input);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultStr });
        toolCalls.push({ name: block.name, input: block.input, result });
        options.onToolResult?.(block.name, result, false);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, tool: block.name }, '[AgenticLoop] Tool execution failed');
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${errMsg}`, is_error: true });
        toolCalls.push({ name: block.name, input: block.input, result: errMsg });
        options.onToolResult?.(block.name, errMsg, true);
      }
    }

    // Send tool results back
    messages.push({ role: 'user', content: toolResults });
  }

  logger.warn(`[AgenticLoop] Max iterations (${maxIter}) reached`);
  return { text: lastText, toolCalls, iterations: maxIter, totalUsage };
}
