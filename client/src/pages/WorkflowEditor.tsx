import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection as FlowConnection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Play,
  Plus,
  Save,
  Settings,
  Unlink,
} from 'lucide-react';
import { toast } from 'sonner';
import AvailableFields from '@/components/editor/AvailableFields';
import FlowNode, { type FlowNodeData } from '@/components/editor/FlowNode';
import NodeConfigPanel from '@/components/editor/NodeConfigPanel';
import NodePalette from '@/components/editor/NodePalette';
import { JsonViewer, Modal, Spinner, StatusBadge, Toggle } from '@/components/ui';
import { findDefinition, useCatalogue } from '@/hooks/useCatalogue';
import { api, errorMessage } from '@/lib/api';
import type {
  Connection,
  Run,
  ValidationIssue,
  Workflow,
  WorkflowEdgeData,
  WorkflowNodeData,
} from '@/lib/types';
import { cn, formatDuration, uid, uniqueName } from '@/lib/utils';

const nodeTypes = { svastha: FlowNode };

function EditorInner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const catalogue = useCatalogue();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [meta, setMeta] = useState<WorkflowNodeData[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [errorEmailTo, setErrorEmailTo] = useState('');
  const [errorEmailConnection, setErrorEmailConnection] = useState('');
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [pinning, setPinning] = useState<{ nodeId: string; name: string; json: string } | null>(
    null,
  );
  const loadedRef = useRef(false);

  const workflowQuery = useQuery({
    queryKey: ['workflow', id],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<{ workflow: Workflow; issues: ValidationIssue[] }>(`/workflows/${id}`)).data,
  });

  /*
   * Hydrate once BOTH the workflow and the node catalogue are available.
   *
   * Waiting for the catalogue matters: node definitions decide how many handles
   * each step renders, and React Flow can only attach an edge to a handle that
   * already exists. Seeding the canvas first and the definitions second left
   * edges unresolved and therefore invisible until a zoom forced a recompute.
   */
  useEffect(() => {
    if (!workflowQuery.data || !catalogue.data || loadedRef.current) return;
    const workflow = workflowQuery.data.workflow;
    loadedRef.current = true;

    setName(workflow.name);
    setDescription(workflow.description ?? '');
    setActive(workflow.active);
    setMeta(workflow.nodes ?? []);
    setIssues(workflowQuery.data.issues ?? []);
    setErrorEmailTo(workflow.settings?.errorEmailTo ?? '');
    setErrorEmailConnection(workflow.settings?.errorEmailConnection ?? '');

    const byId = new Map((workflow.nodes ?? []).map((node) => [node.id, node]));

    setNodes(
      (workflow.nodes ?? []).map((node) => ({
        id: node.id,
        type: 'svastha',
        position: node.position,
        data: {
          label: node.name,
          disabled: node.disabled,
          // Present immediately, so handles render on the very first pass.
          definition: findDefinition(catalogue.data, node.type),
          subtitle: findDefinition(catalogue.data, node.type)?.displayName,
        } as FlowNodeData,
      })),
    );

    setEdges(
      (workflow.edges ?? [])
        // Drop edges pointing at steps that no longer exist rather than letting
        // React Flow silently discard them (and lose them on the next save).
        .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
        .map((edge) => {
          const targetDefinition = findDefinition(catalogue.data, byId.get(edge.target)!.type);
          const namedInputs = (targetDefinition?.inputHandles ?? []).map((input) => input.name);

          return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle: edge.sourceHandle ?? 'main',
            /*
             * Single-input steps use the default unnamed handle, so their edges
             * must carry `null`. Only keep a stored name when the target really
             * does expose a handle by that name — otherwise the edge would
             * reference a handle that does not exist and vanish again.
             */
            targetHandle:
              edge.targetHandle && namedInputs.includes(edge.targetHandle)
                ? edge.targetHandle
                : null,
            animated: true,
            type: 'smoothstep',
          };
        }),
    );
  }, [workflowQuery.data, catalogue.data, setNodes, setEdges]);

  const definitionsByType = useMemo(() => {
    const map = new Map<string, ReturnType<typeof findDefinition>>();
    for (const node of meta) map.set(node.id, findDefinition(catalogue.data, node.type));
    return map;
  }, [meta, catalogue.data]);

  // Keep the visual nodes in sync with metadata (name, definition, issues).
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        const info = meta.find((item) => item.id === node.id);
        if (!info) return node;
        const issue = issues.find((entry) => entry.nodeId === node.id);
        return {
          ...node,
          data: {
            ...node.data,
            label: info.name,
            disabled: info.disabled,
            definition: definitionsByType.get(info.id),
            hasIssue: Boolean(issue),
            issueMessage: issue?.message,
            subtitle: definitionsByType.get(info.id)?.displayName,
          } as FlowNodeData,
        };
      }),
    );
  }, [meta, issues, definitionsByType, setNodes]);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: async () =>
      (await api.get<{ connections: Connection[] }>('/connections')).data.connections,
  });

  const runQuery = useQuery({
    queryKey: ['run', activeRunId],
    enabled: Boolean(activeRunId),
    refetchInterval: (query) => {
      const status = (query.state.data as Run | undefined)?.status;
      return status === 'queued' || status === 'running' ? 1000 : false;
    },
    queryFn: async () => (await api.get<{ run: Run }>(`/runs/${activeRunId}`)).data.run,
  });

  // Paint the last run result onto the canvas.
  useEffect(() => {
    const run = runQuery.data;
    if (!run) return;
    setNodes((current) =>
      current.map((node) => {
        const step = [...run.steps].reverse().find((entry) => entry.nodeId === node.id);
        return { ...node, data: { ...node.data, runStatus: step?.status } as FlowNodeData };
      }),
    );
  }, [runQuery.data, setNodes]);

  const markDirty = useCallback(() => setDirty(true), []);

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<FlowNodeData>>[]) => {
      onNodesChange(changes);
      if (changes.some((change) => change.type === 'position' && change.dragging === false)) {
        markDirty();
      }
    },
    [onNodesChange, markDirty],
  );

  const onConnect = useCallback(
    (connection: FlowConnection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: uid('edge'),
            animated: true,
            type: 'smoothstep',
            sourceHandle: connection.sourceHandle ?? 'main',
            targetHandle: connection.targetHandle ?? null,
          },
          current,
        ),
      );
      markDirty();
    },
    [setEdges, markDirty],
  );

  const addNode = useCallback(
    (definitionType: string) => {
      const definition = findDefinition(catalogue.data, definitionType);
      if (!definition) return;

      const newId = uid('node');
      const existingNames = meta.map((node) => node.name);
      const anchor = selectedId ? nodes.find((node) => node.id === selectedId) : undefined;
      const basePosition = anchor
        ? { x: anchor.position.x + 300, y: anchor.position.y }
        : { x: 120 + meta.length * 60, y: 200 + meta.length * 40 };

      const newMeta: WorkflowNodeData = {
        id: newId,
        type: definition.type,
        name: uniqueName(definition.displayName, existingNames),
        position: basePosition,
        params: { ...(definition.defaults ?? {}) },
        onError: 'stop',
      };

      setMeta((current) => [...current, newMeta]);
      setNodes((current) => [
        ...current,
        {
          id: newId,
          type: 'svastha',
          position: basePosition,
          data: { label: newMeta.name, definition } as FlowNodeData,
        },
      ]);

      // Auto-connect from the currently selected step for a fast build flow.
      if (anchor && definition.group !== 'trigger') {
        const anchorDefinition = definitionsByType.get(anchor.id);
        const handle = anchorDefinition?.outputs?.[0]?.name ?? 'main';
        setEdges((current) => [
          ...current,
          {
            id: uid('edge'),
            source: anchor.id,
            target: newId,
            sourceHandle: handle,
            animated: true,
            type: 'smoothstep',
          },
        ]);
      }

      setSelectedId(newId);
      setPaletteOpen(false);
      markDirty();
    },
    [catalogue.data, meta, nodes, selectedId, definitionsByType, setNodes, setEdges, markDirty],
  );

  const updateNodeMeta = useCallback(
    (nodeId: string, patch: Partial<WorkflowNodeData>) => {
      setMeta((current) =>
        current.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
      );
      markDirty();
    },
    [markDirty],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      setMeta((current) => current.filter((node) => node.id !== nodeId));
      setNodes((current) => current.filter((node) => node.id !== nodeId));
      setEdges((current) =>
        current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      );
      setSelectedId(null);
      markDirty();
    },
    [setNodes, setEdges, markDirty],
  );

  const buildPayload = useCallback(() => {
    const positions = new Map(nodes.map((node) => [node.id, node.position]));
    const nodePayload: WorkflowNodeData[] = meta.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    }));
    const edgePayload: WorkflowEdgeData[] = edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? 'main',
      targetHandle: edge.targetHandle ?? 'main',
    }));
    return {
      name,
      description,
      active,
      nodes: nodePayload,
      edges: edgePayload,
      variables: workflowQuery.data?.workflow.variables ?? {},
      settings: {
        ...workflowQuery.data?.workflow.settings,
        errorEmailTo,
        errorEmailConnection: errorEmailConnection || null,
      },
      tags: workflowQuery.data?.workflow.tags ?? [],
    };
  }, [
    nodes,
    edges,
    meta,
    name,
    description,
    active,
    workflowQuery.data,
    errorEmailTo,
    errorEmailConnection,
  ]);

  const save = useMutation({
    mutationFn: async () => {
      const { data } = await api.put<{ workflow: Workflow; issues: ValidationIssue[] }>(
        `/workflows/${id}`,
        buildPayload(),
      );
      return data;
    },
    onSuccess: (data) => {
      setIssues(data.issues ?? []);
      setDirty(false);
      queryClient.setQueryData(['workflow', id], data);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success('Workflow saved');
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not save')),
  });

  const toggleActive = useMutation({
    mutationFn: async (next: boolean) => {
      if (dirty) await api.put(`/workflows/${id}`, { ...buildPayload(), active: false });
      const { data } = await api.patch<{ workflow: Workflow }>(`/workflows/${id}/active`, {
        active: next,
      });
      return data.workflow;
    },
    onSuccess: (workflow) => {
      setActive(workflow.active);
      setDirty(false);
      toast.success(workflow.active ? 'Workflow is live' : 'Workflow paused');
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not change the status')),
  });

  /** The step immediately upstream — whose output this step will receive. */
  const previousNodeId = useCallback(
    (nodeId: string) => edges.find((edge) => edge.target === nodeId)?.source,
    [edges],
  );

  const openPinDialog = useCallback(
    (nodeId: string) => {
      const target = meta.find((entry) => entry.id === nodeId);
      setPinning({
        nodeId,
        name: target?.name ?? 'this step',
        json: target?.pinnedData ? JSON.stringify(target.pinnedData, null, 2) : '',
      });
    },
    [meta],
  );

  const duplicateNode = useCallback(
    (nodeId: string) => {
      const source = meta.find((entry) => entry.id === nodeId);
      const visual = nodes.find((entry) => entry.id === nodeId);
      if (!source || !visual) return;

      const newId = uid('node');
      const copy: WorkflowNodeData = {
        ...structuredClone(source),
        id: newId,
        name: uniqueName(source.name, meta.map((entry) => entry.name)),
        position: { x: visual.position.x + 40, y: visual.position.y + 120 },
      };

      setMeta((current) => [...current, copy]);
      setNodes((current) => [
        ...current,
        {
          id: newId,
          type: 'svastha',
          position: copy.position,
          data: { label: copy.name, definition: definitionsByType.get(nodeId) } as FlowNodeData,
        },
      ]);
      setSelectedId(newId);
      markDirty();
      toast.success(`Duplicated "${source.name}"`);
    },
    [meta, nodes, definitionsByType, setNodes, markDirty],
  );

  const pinData = useMutation({
    mutationFn: async ({ nodeId, json }: { nodeId: string; json: string }) => {
      // Persist locally too, so the value survives the next Save.
      await api.patch(`/workflows/${id}/nodes/${nodeId}/pin`, { data: json });
      return { nodeId, json };
    },
    onSuccess: ({ nodeId, json }) => {
      setMeta((current) =>
        current.map((entry) =>
          entry.id === nodeId
            ? { ...entry, pinnedData: json.trim() ? JSON.parse(json) : undefined }
            : entry,
        ),
      );
      setPinning(null);
      void queryClient.invalidateQueries({ queryKey: ['fields', id] });
      toast.success(json.trim() ? 'Sample data pinned' : 'Pinned data cleared');
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not pin that data')),
  });

  const runFromHere = useMutation({
    mutationFn: async (nodeId: string) => {
      if (dirty) await api.put(`/workflows/${id}`, buildPayload());
      const { data } = await api.post<{ runId: string; startedFrom: string }>(
        `/workflows/${id}/run`,
        { startFromNodeId: nodeId },
      );
      return data;
    },
    onSuccess: (data) => {
      setDirty(false);
      setActiveRunId(data.runId);
      setRunPanelOpen(true);
      toast.success(`Running from "${data.startedFrom}"`);
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not start from that step')),
  });

  const testRun = useMutation({
    mutationFn: async () => {
      if (dirty) await api.put(`/workflows/${id}`, buildPayload());
      const trigger = meta.find(
        (node) => definitionsByType.get(node.id)?.group === 'trigger',
      );
      const { data } = await api.post<{ runId: string }>(`/workflows/${id}/run`, {
        triggerNodeId: trigger?.id,
      });
      return data.runId;
    },
    onSuccess: (runId) => {
      setDirty(false);
      setActiveRunId(runId);
      setRunPanelOpen(true);
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not start a test run')),
  });

  // Ctrl/Cmd+S to save.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!save.isPending) save.mutate();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [save]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const selectedMeta = meta.find((node) => node.id === selectedId);
  const errorIssues = issues.filter((issue) => issue.level === 'error');
  const warningIssues = issues.filter((issue) => issue.level === 'warning');
  const hasTrigger = meta.some((node) => definitionsByType.get(node.id)?.group === 'trigger');
  const webhookUrls = workflowQuery.data?.workflow.webhookUrls ?? {};

  if (workflowQuery.isLoading || catalogue.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-brand-600" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <button
          className="btn-ghost p-1.5"
          onClick={() => {
            if (dirty && !confirm('You have unsaved changes. Leave anyway?')) return;
            navigate('/workflows');
          }}
          aria-label="Back to workflows"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1">
          <input
            className="w-full max-w-md rounded border border-transparent px-1.5 py-1 text-sm font-semibold text-slate-900 hover:border-slate-200 focus:border-brand-500 focus:outline-none"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              markDirty();
            }}
          />
        </div>

        {dirty ? (
          <span className="badge bg-amber-50 text-amber-700 ring-1 ring-amber-200">
            Unsaved changes
          </span>
        ) : null}

        <button className="btn-ghost p-2" onClick={() => setSettingsOpen(true)} title="Workflow settings">
          <Settings className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5">
          <Toggle
            checked={active}
            onChange={(next) => toggleActive.mutate(next)}
            disabled={toggleActive.isPending}
          />
          <span className="text-xs font-medium text-slate-600">{active ? 'Live' : 'Paused'}</span>
        </div>

        <button
          className="btn-secondary"
          onClick={() => testRun.mutate()}
          disabled={testRun.isPending || !hasTrigger}
        >
          {testRun.isPending ? <Spinner /> : <Play className="h-4 w-4" />}
          Test run
        </button>

        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? <Spinner /> : <Save className="h-4 w-4" />}
          Save
        </button>
      </header>

      {errorIssues.length > 0 ? (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <span className="font-semibold">Needs attention before going live:</span>{' '}
            {errorIssues.map((issue) => issue.message).join(' · ')}
          </div>
        </div>
      ) : null}

      {/* Disconnected steps are the visible symptom of a lost connection. */}
      {warningIssues.length > 0 ? (
        <div className="flex items-start gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          <Unlink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          <div>{warningIssues.map((issue) => issue.message).join(' · ')}</div>
        </div>
      ) : null}

      <div className="relative flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={(changes) => {
            onEdgesChange(changes);
            if (changes.some((change) => change.type === 'remove')) markDirty();
          }}
          onConnect={onConnect}
          onNodeClick={(_event, node) => {
            setSelectedId(node.id);
            setPaletteOpen(false);
          }}
          onPaneClick={() => setSelectedId(null)}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={['Backspace', 'Delete']}
          onNodesDelete={(deleted) => {
            setMeta((current) => current.filter((node) => !deleted.some((d) => d.id === node.id)));
            markDirty();
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} color="#cbd5e1" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => (node.data as FlowNodeData)?.definition?.color ?? '#94a3b8'}
            className="!bottom-4 !right-4 hidden lg:!block"
          />
        </ReactFlow>

        <button
          className="btn-primary absolute left-4 top-4 z-10 shadow-panel"
          onClick={() => setPaletteOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Add step
        </button>

        {meta.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-xl border border-dashed border-slate-300 bg-white/80 px-8 py-10 text-center backdrop-blur">
              <h3 className="text-sm font-semibold text-slate-800">This canvas is empty</h3>
              <p className="mt-1 max-w-xs text-xs text-slate-500">
                Start with a trigger — a Webhook to receive data, or a Schedule to run on a timer.
              </p>
            </div>
          </div>
        ) : null}

        <NodePalette
          open={paletteOpen}
          nodes={catalogue.data?.nodes ?? []}
          allowTriggers
          onPick={(definition) => addNode(definition.type)}
          onClose={() => setPaletteOpen(false)}
        />

        {selectedMeta && !paletteOpen ? (
          <>
            {/* Triggers have nothing upstream, so there is nothing to reference. */}
            {definitionsByType.get(selectedMeta.id)?.group !== 'trigger' && id ? (
              <AvailableFields
                workflowId={id}
                nodeId={selectedMeta.id}
                onTestRun={() => testRun.mutate()}
                onPinData={() => openPinDialog(previousNodeId(selectedMeta.id) ?? selectedMeta.id)}
              />
            ) : null}

            <NodeConfigPanel
              node={selectedMeta}
              definition={definitionsByType.get(selectedMeta.id)}
              catalogue={catalogue.data}
              webhookUrl={webhookUrls[selectedMeta.id]}
              onChange={(patch) => updateNodeMeta(selectedMeta.id, patch)}
              onDelete={() => deleteNode(selectedMeta.id)}
              onClose={() => setSelectedId(null)}
              onDuplicate={() => duplicateNode(selectedMeta.id)}
              onPinData={() => openPinDialog(selectedMeta.id)}
              onRunFromHere={
                definitionsByType.get(selectedMeta.id)?.group === 'trigger'
                  ? undefined
                  : () => runFromHere.mutate(selectedMeta.id)
              }
            />
          </>
        ) : null}
      </div>

      {/* Run inspector */}
      <div
        className={cn(
          'border-t border-slate-200 bg-white transition-all',
          runPanelOpen ? 'h-72' : 'h-10',
        )}
      >
        <button
          className="flex w-full items-center justify-between px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
          onClick={() => setRunPanelOpen((open) => !open)}
        >
          <span className="flex items-center gap-2">
            Run details
            {runQuery.data ? <StatusBadge status={runQuery.data.status} /> : null}
            {runQuery.data?.durationMs !== undefined ? (
              <span className="text-slate-400">{formatDuration(runQuery.data.durationMs)}</span>
            ) : null}
          </span>
          {runPanelOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>

        {runPanelOpen ? (
          <div className="h-[calc(100%-2.5rem)] overflow-y-auto px-4 pb-4">
            {!runQuery.data ? (
              <p className="py-8 text-center text-sm text-slate-500">
                Press <span className="font-medium">Test run</span> to execute the workflow and see
                what each step received and produced.
              </p>
            ) : (
              <div className="space-y-2">
                {runQuery.data.error ? (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    {runQuery.data.error}
                  </div>
                ) : null}

                {runQuery.data.steps.map((step, index) => (
                  <div key={`${step.nodeId}-${index}`} className="rounded-lg border border-slate-200">
                    <button
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50"
                      onClick={() =>
                        setExpandedStep(
                          expandedStep === `${step.nodeId}-${index}` ? null : `${step.nodeId}-${index}`,
                        )
                      }
                    >
                      <StatusBadge status={step.status} />
                      <span className="flex-1 truncate text-sm font-medium text-slate-800">
                        {step.nodeName}
                      </span>
                      <span className="text-xs text-slate-400">
                        {formatDuration(step.durationMs)}
                      </span>
                    </button>

                    {expandedStep === `${step.nodeId}-${index}` ? (
                      <div className="grid gap-3 border-t border-slate-100 p-3 md:grid-cols-2">
                        <div>
                          <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">
                            Input
                          </div>
                          <JsonViewer value={step.input} className="max-h-48" />
                        </div>
                        <div>
                          <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">
                            {step.error ? 'Error' : 'Output'}
                          </div>
                          {step.error ? (
                            <pre className="max-h-48 overflow-auto rounded-lg bg-rose-50 p-3 font-mono text-xs text-rose-700">
                              {step.error}
                            </pre>
                          ) : (
                            <JsonViewer value={step.output} className="max-h-48" />
                          )}
                        </div>
                        {step.logs && step.logs.length > 0 ? (
                          <div className="md:col-span-2">
                            <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">
                              Logs
                            </div>
                            <pre className="max-h-32 overflow-auto rounded-lg bg-slate-100 p-2 font-mono text-[11px] text-slate-700">
                              {step.logs.join('\n')}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Workflow settings"
        footer={
          <button className="btn-primary" onClick={() => setSettingsOpen(false)}>
            Done
          </button>
        }
      >
        <label className="label">Description</label>
        <textarea
          className="input mb-4"
          rows={3}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            markDirty();
          }}
          placeholder="What does this automation do?"
        />

        <label className="label">When a run fails</label>
        <div className="mb-4 grid gap-3">
          <input
            className="input"
            placeholder="Email these addresses on failure (comma separated)"
            value={errorEmailTo}
            onChange={(event) => {
              setErrorEmailTo(event.target.value);
              markDirty();
            }}
          />
          <p className="text-xs text-slate-500">
            Alerts use the SMTP connection selected below. Leave the addresses blank to turn
            alerting off.
          </p>
          <select
            className="input"
            value={errorEmailConnection}
            onChange={(event) => {
              setErrorEmailConnection(event.target.value);
              markDirty();
            }}
          >
            <option value="">— no connection selected —</option>
            {(connections.data ?? [])
              .filter((connection) => connection.type === 'smtp')
              .map((connection) => (
                <option key={connection._id} value={connection._id}>
                  {connection.name}
                </option>
              ))}
          </select>
        </div>

        <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          <p className="mb-1 font-semibold text-slate-700">Shortcuts</p>
          <p>Ctrl/Cmd + S — save · Delete — remove selected step · Drag from a dot to connect steps</p>
        </div>
      </Modal>

      <Modal
        open={Boolean(pinning)}
        onClose={() => setPinning(null)}
        title={`Pin sample data for "${pinning?.name ?? ''}"`}
        description="Paste an example of what this step produces. Later steps can then be configured — and their fields browsed — without running anything."
        wide
        footer={
          <>
            {pinning?.json ? (
              <button
                className="btn-ghost mr-auto text-rose-600"
                onClick={() => pinData.mutate({ nodeId: pinning.nodeId, json: '' })}
              >
                Clear pinned data
              </button>
            ) : null}
            <button className="btn-secondary" onClick={() => setPinning(null)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={pinData.isPending}
              onClick={() => pinning && pinData.mutate({ nodeId: pinning.nodeId, json: pinning.json })}
            >
              {pinData.isPending ? <Spinner /> : null}
              Pin data
            </button>
          </>
        }
      >
        <textarea
          className="code-area"
          rows={14}
          spellCheck={false}
          placeholder={'{\n  "body": {\n    "first_name": "Sumit",\n    "email": "sumit@example.com"\n  }\n}'}
          value={pinning?.json ?? ''}
          onChange={(event) =>
            setPinning((current) => (current ? { ...current, json: event.target.value } : current))
          }
        />
        <p className="mt-2 text-xs text-slate-500">
          Must be valid JSON. Tip: copy the Input or Output panel from any previous run.
        </p>
      </Modal>
    </div>
  );
}

export default function WorkflowEditor() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}
