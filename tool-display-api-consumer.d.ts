export type RuntimeToolDefinition = Record<string, unknown>;

export type ToolDisplayKind = "read" | "edit" | "mcp" | "generic";

export interface ToolDisplayAdapter {
  /** Stable id for later removal; defaults to toolName or an internal id. */
  id?: string;
  /** Name used when registering an adapter for later decorateTool calls. */
  toolName?: string;
  kind?: ToolDisplayKind;
  overrideExistingRenderers?: boolean;
  /** Preserve a native call renderer while replacing the result renderer. */
  preserveCallRenderer?: boolean;
  pathFields?: string[];
  getPath?: (args: unknown) => string | undefined;
  getEditLineCount?: (args: unknown) => number;
  renderCall?: (args: unknown, theme: unknown, context: unknown) => unknown;
  renderResult?: (result: unknown, options: unknown, theme: unknown, context?: unknown) => unknown;
}

export interface ToolDisplayApi {
  version: 1;
  decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T;
  registerAdapter(adapter: ToolDisplayAdapter): string;
  unregisterAdapter(id: string): boolean;
}

export interface DecorateToolForDisplayOptions {
  suppressDecorateErrors?: boolean;
}

export declare function getToolDisplayApi(): ToolDisplayApi | undefined;

/**
 * Queues a decoration until pi-tool-display installs its runtime API. The queue
 * retains at most the 100 most recently requested decorations.
 */
export declare function queueToolDisplayDecoration<T extends RuntimeToolDefinition>(
  tool: T,
  adapter?: ToolDisplayAdapter,
): void;

export declare function decorateToolForDisplay<T extends RuntimeToolDefinition>(
  tool: T,
  adapter?: ToolDisplayAdapter,
  options?: DecorateToolForDisplayOptions,
): T;

export declare function decorateMcpToolForDisplay<T extends RuntimeToolDefinition>(tool: T): T;
