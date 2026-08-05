/**
 * Core contracts for the SVASTHA Automator execution engine.
 *
 * Everything the UI renders (node palette, config forms, help text) is derived from
 * the `NodeDefinition` objects registered in `engine/registry.ts`. Adding a new
 * integration therefore means writing ONE file - no frontend changes required.
 */

export type NodeGroup = 'trigger' | 'action' | 'logic' | 'transform';

export type PropertyType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'json'
  | 'code'
  | 'keyValue'
  | 'collection'
  | 'connection'
  | 'notice';

export interface PropertyOption {
  label: string;
  value: string;
  description?: string;
}

/** Show a property only when sibling properties have specific values. */
export interface DisplayOptions {
  show?: Record<string, Array<string | number | boolean>>;
  hide?: Record<string, Array<string | number | boolean>>;
}

export interface NodeProperty {
  name: string;
  label: string;
  type: PropertyType;
  default?: unknown;
  required?: boolean;
  placeholder?: string;
  description?: string;
  options?: PropertyOption[];
  /** For `connection` properties: which connection type to list. */
  connectionType?: string;
  /** For `collection` properties: the shape of each row. */
  fields?: NodeProperty[];
  displayOptions?: DisplayOptions;
  /** Set false for properties that must not run through the expression resolver. */
  resolveExpressions?: boolean;
  /** Language hint for `code` properties. */
  language?: 'javascript' | 'json' | 'html' | 'plaintext';
  rows?: number;
}

export interface NodeOutputDefinition {
  /** Handle id used by edges. `main` is the default output. */
  name: string;
  label: string;
  description?: string;
}

export interface NodeDefinition {
  /** Stable machine name, e.g. `httpRequest`. Never change it once released. */
  type: string;
  displayName: string;
  group: NodeGroup;
  version: number;
  description: string;
  /** lucide-react icon name rendered by the frontend. */
  icon: string;
  color: string;
  /** Triggers have no input handle. */
  inputs: number;
  outputs: NodeOutputDefinition[];
  properties: NodeProperty[];
  /** Trigger-only: how the workflow is started. */
  triggerKind?: 'webhook' | 'schedule' | 'manual';
  docsUrl?: string;
  /** Executed for action/logic/transform nodes. Triggers may omit it. */
  execute?: (ctx: NodeExecutionContext) => Promise<NodeExecutionResult>;
}

export interface WorkflowNode {
  id: string;
  type: string;
  name: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
  /** What to do when this node throws: stop the run, or continue with the error payload. */
  onError?: 'stop' | 'continue';
  /** Automatic retries for transient failures. */
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTriesMs?: number;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Output handle on the source node (`main`, `true`, `false`, ...). */
  sourceHandle?: string;
}

/** Data made available to expressions such as {{ $json.email }}. */
export interface ExpressionScope {
  /** Output of the immediately preceding node. */
  $json: Record<string, unknown>;
  /** Original trigger payload. */
  $trigger: Record<string, unknown>;
  /** All node outputs keyed by node name: {{ $node["Fetch user"].json.id }} */
  $node: Record<string, { json: unknown }>;
  /** Workflow-level static variables. */
  $vars: Record<string, unknown>;
  $runId: string;
  $workflowId: string;
  $workflowName: string;
  $now: string;
  $timestamp: number;
}

export interface NodeExecutionContext {
  node: WorkflowNode;
  /** Params with all {{ }} expressions already resolved. */
  params: Record<string, unknown>;
  /** Raw params, for nodes that need the un-resolved template (rare). */
  rawParams: Record<string, unknown>;
  input: Record<string, unknown>;
  scope: ExpressionScope;
  runId: string;
  workflowId: string;
  /** Resolves a saved connection and returns its decrypted config. */
  getConnection: (id: string) => Promise<Record<string, unknown>>;
  /** Re-runs the expression resolver on an arbitrary value at execution time. */
  resolve: <T = unknown>(value: T) => T;
  log: (message: string, data?: unknown) => void;
  signal: AbortSignal;
}

export type NodeExecutionResult =
  | {
      /** Normal completion. */
      kind: 'output';
      data: Record<string, unknown>;
      /** Restrict which output handles continue. Defaults to ['main']. */
      outputs?: string[];
    }
  | {
      /** Stop this branch without failing the run (used by Filter). */
      kind: 'stop';
      data?: Record<string, unknown>;
      reason?: string;
    }
  | {
      /** Pause and resume after `resumeAt` (used by Delay). */
      kind: 'wait';
      resumeAt: Date;
      data: Record<string, unknown>;
    };

export interface RunStepRecord {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: 'success' | 'error' | 'skipped' | 'stopped' | 'waiting';
  input?: unknown;
  output?: unknown;
  error?: string;
  logs?: string[];
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  tries?: number;
}

/** Serialisable engine state so a paused run can resume in another process. */
export interface RunState {
  nodeOutputs: Record<string, unknown>;
  nodeNameToId: Record<string, string>;
  queue: Array<{ nodeId: string; input: Record<string, unknown> }>;
  executed: string[];
}
