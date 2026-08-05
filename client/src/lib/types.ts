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
  connectionType?: string;
  fields?: NodeProperty[];
  displayOptions?: DisplayOptions;
  resolveExpressions?: boolean;
  language?: string;
  rows?: number;
}

export interface NodeOutputDefinition {
  name: string;
  label: string;
  description?: string;
}

export interface NodeTypeDefinition {
  type: string;
  displayName: string;
  group: NodeGroup;
  version: number;
  description: string;
  icon: string;
  color: string;
  inputs: number;
  outputs: NodeOutputDefinition[];
  properties: NodeProperty[];
  triggerKind?: 'webhook' | 'schedule' | 'manual';
  defaults?: Record<string, unknown>;
}

export interface ConnectionTypeDefinition {
  type: string;
  displayName: string;
  description: string;
  icon: string;
  properties: NodeProperty[];
  previewFields: string[];
}

export interface Catalogue {
  nodes: NodeTypeDefinition[];
  connections: ConnectionTypeDefinition[];
  expressionHelpers: string[];
  expressionVariables: Array<{ name: string; description: string }>;
}

export interface WorkflowNodeData {
  id: string;
  type: string;
  name: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
  onError?: 'stop' | 'continue';
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTriesMs?: number;
}

export interface WorkflowEdgeData {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

export interface WorkflowStats {
  runs: number;
  success: number;
  errors: number;
  lastRunAt?: string;
  lastRunStatus?: string;
}

export interface Workflow {
  _id: string;
  id?: string;
  name: string;
  description: string;
  active: boolean;
  nodes: WorkflowNodeData[];
  edges: WorkflowEdgeData[];
  variables: Record<string, unknown>;
  webhookId?: string;
  webhookUrls?: Record<string, string>;
  tags: string[];
  settings: {
    timezone: string;
    saveSuccessfulRunData: boolean;
    saveFailedRunData: boolean;
    timeoutMs: number;
  };
  stats: WorkflowStats;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

export type RunStatus = 'queued' | 'running' | 'waiting' | 'success' | 'error' | 'cancelled';

export interface RunStep {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: 'success' | 'error' | 'skipped' | 'stopped' | 'waiting';
  input?: unknown;
  output?: unknown;
  error?: string;
  logs?: string[];
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  tries?: number;
}

export interface Run {
  _id: string;
  workflow: string;
  workflowName: string;
  status: RunStatus;
  mode: 'webhook' | 'schedule' | 'manual' | 'test';
  trigger?: { nodeId?: string; nodeName?: string; payload?: unknown };
  steps: RunStep[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  createdAt: string;
}

export interface Connection {
  _id: string;
  name: string;
  type: string;
  preview: Record<string, unknown>;
  lastTestedAt?: string;
  lastTestOk?: boolean;
  lastTestError?: string;
  createdAt: string;
}

export interface User {
  _id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  active: boolean;
  lastLoginAt?: string;
  createdAt: string;
}
