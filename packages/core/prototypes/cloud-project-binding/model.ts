import { createHash } from "node:crypto";

/**
 * PROTOTYPE — wipe me after the Project Binding contract is accepted.
 *
 * Question: can a durable logical workspace survive cloud compute replacement while
 * local project files remain authoritative, transport sessions remain ephemeral,
 * and stale or divergent clients are prevented from publishing checkpoints?
 */

export type BindingStatus =
  | "unbound"
  | "connecting"
  | "restoring"
  | "reconciling"
  | "ready"
  | "disconnected"
  | "quarantined"
  | "recovering";

export type Manifest = Record<string, string>;

export type BindingReceipt = {
  workspaceId: string;
  acceptedGeneration: number;
  checkpointRevision: number;
  manifestDigest: string;
  pendingAttachId?: string;
};

export type DurableWorkspace = {
  workspaceId: string;
  projectFingerprint: string;
  authorityClientFingerprint: string;
  acceptedGeneration: number;
  checkpointRevision: number;
  checkpoint: Manifest;
  status: BindingStatus;
  lastSyncTick?: number;
  acceptedAttachId: string;
  lastRejectedAttach?: {
    clientFingerprint: string;
    reason: "stale_generation" | "stale_checkpoint" | "divergent_manifest";
  };
};

export type TransportSession = {
  sessionId: string;
  workspaceId: string;
  clientFingerprint: string;
  generation: number;
  expectedCheckpointRevision: number;
  localManifest: Manifest;
  materializedManifest: Manifest;
  status: BindingStatus;
  reason?: string;
};

export type PrototypeState = {
  tick: number;
  nextWorkspace: number;
  nextSession: number;
  workspaces: Record<string, DurableWorkspace>;
  sessions: Record<string, TransportSession>;
  receipts: Record<string, BindingReceipt>;
};

export type PrototypeResult = {
  state: PrototypeState;
  message: string;
  sessionId?: string;
  workspaceId?: string;
};

export function createPrototypeState(): PrototypeState {
  return {
    tick: 0,
    nextWorkspace: 1,
    nextSession: 1,
    workspaces: {},
    sessions: {},
    receipts: {},
  };
}

export function bindNewWorkspace(
  state: PrototypeState,
  input: {
    clientFingerprint: string;
    projectFingerprint: string;
    localManifest: Manifest;
  },
): PrototypeResult {
  const next = cloneState(state);
  next.tick += 1;
  const workspaceId = `ws-${next.nextWorkspace++}`;
  const sessionId = `transport-${next.nextSession++}`;
  const checkpoint = cloneManifest(input.localManifest);
  const workspace: DurableWorkspace = {
    workspaceId,
    projectFingerprint: input.projectFingerprint,
    authorityClientFingerprint: input.clientFingerprint,
    acceptedGeneration: 1,
    checkpointRevision: 1,
    checkpoint,
    status: "ready",
    acceptedAttachId: "initial-bind",
    lastSyncTick: next.tick,
  };
  next.workspaces[workspaceId] = workspace;
  next.sessions[sessionId] = {
    sessionId,
    workspaceId,
    clientFingerprint: input.clientFingerprint,
    generation: 1,
    expectedCheckpointRevision: 1,
    localManifest: cloneManifest(input.localManifest),
    materializedManifest: checkpoint,
    status: "ready",
  };
  next.receipts[receiptKey(input.clientFingerprint, input.projectFingerprint)] =
    receiptFrom(workspace);
  return {
    state: next,
    workspaceId,
    sessionId,
    message: `Created ${workspaceId}; local manifest became checkpoint r1 at generation 1.`,
  };
}

export function stageAttach(
  state: PrototypeState,
  input: {
    clientFingerprint: string;
    projectFingerprint: string;
    attemptId: string;
  },
): PrototypeResult {
  const next = cloneState(state);
  next.tick += 1;
  const receipt = next.receipts[receiptKey(input.clientFingerprint, input.projectFingerprint)];
  if (!receipt) {
    return {
      state: next,
      message: "Attach cannot be staged without a local binding receipt.",
    };
  }
  receipt.pendingAttachId = input.attemptId;
  return {
    state: next,
    workspaceId: receipt.workspaceId,
    message: `Persisted pending attach ${input.attemptId} locally before contacting the runtime.`,
  };
}

export function attachWorkspace(
  state: PrototypeState,
  input: {
    clientFingerprint: string;
    projectFingerprint: string;
    attemptId: string;
    localManifest: Manifest;
    workspaceId?: string;
    loseResponse?: boolean;
  },
): PrototypeResult {
  const next = cloneState(state);
  next.tick += 1;
  const receipt = input.workspaceId
    ? next.receipts[receiptKey(input.clientFingerprint, input.projectFingerprint)]
    : undefined;
  const workspaceId = input.workspaceId ?? receipt?.workspaceId;
  const workspace = workspaceId ? next.workspaces[workspaceId] : undefined;
  if (!workspace || !receipt || receipt.workspaceId !== workspace.workspaceId) {
    return {
      state: next,
      message:
        "Attach rejected: no local binding receipt selects that logical workspace. Create a new binding or explicitly transfer authority.",
    };
  }

  const replaysAcceptedAttempt =
    workspace.acceptedAttachId === input.attemptId &&
    workspace.authorityClientFingerprint === input.clientFingerprint;
  if (!replaysAcceptedAttempt && receipt.pendingAttachId !== input.attemptId) {
    return {
      state: next,
      workspaceId: workspace.workspaceId,
      message:
        "Attach rejected: stage this attempt in the local Remote Profile before contacting the runtime.",
    };
  }

  const staleGeneration = receipt.acceptedGeneration !== workspace.acceptedGeneration;
  const staleCheckpoint = receipt.checkpointRevision !== workspace.checkpointRevision;
  const divergentManifest =
    receipt.manifestDigest !== digestManifest(input.localManifest) && staleCheckpoint;
  if (!replaysAcceptedAttempt && (staleGeneration || staleCheckpoint)) {
    const reason = divergentManifest
      ? "divergent_manifest"
      : staleGeneration
        ? "stale_generation"
        : "stale_checkpoint";
    const sessionId = `transport-${next.nextSession++}`;
    next.sessions[sessionId] = {
      sessionId,
      workspaceId: workspace.workspaceId,
      clientFingerprint: input.clientFingerprint,
      generation: receipt.acceptedGeneration,
      expectedCheckpointRevision: receipt.checkpointRevision,
      localManifest: cloneManifest(input.localManifest),
      materializedManifest: cloneManifest(workspace.checkpoint),
      status: "quarantined",
      reason,
    };
    workspace.lastRejectedAttach = {
      clientFingerprint: input.clientFingerprint,
      reason,
    };
    return {
      state: next,
      sessionId,
      workspaceId: workspace.workspaceId,
      message: `Attach quarantined: ${reason}; the accepted workspace remains ${workspace.status}.`,
    };
  }

  if (!replaysAcceptedAttempt) {
    workspace.acceptedGeneration += 1;
    workspace.acceptedAttachId = input.attemptId;
    workspace.authorityClientFingerprint = input.clientFingerprint;
  }
  if (input.loseResponse) {
    workspace.status = "disconnected";
    return {
      state: next,
      workspaceId: workspace.workspaceId,
      message: `Runtime accepted ${input.attemptId} at generation ${workspace.acceptedGeneration}, but the response was lost; the persisted pending attempt can replay without another increment.`,
    };
  }

  workspace.status = "reconciling";
  delete workspace.lastRejectedAttach;
  Object.assign(receipt, receiptFrom(workspace));
  delete receipt.pendingAttachId;
  const sessionId = `transport-${next.nextSession++}`;
  next.sessions[sessionId] = {
    sessionId,
    workspaceId: workspace.workspaceId,
    clientFingerprint: input.clientFingerprint,
    generation: workspace.acceptedGeneration,
    expectedCheckpointRevision: workspace.checkpointRevision,
    localManifest: cloneManifest(input.localManifest),
    materializedManifest: cloneManifest(workspace.checkpoint),
    status: "reconciling",
  };
  return {
    state: next,
    sessionId,
    workspaceId: workspace.workspaceId,
    message: `${replaysAcceptedAttempt ? "Replayed" : "Accepted"} ${input.attemptId} at generation ${workspace.acceptedGeneration}; restored checkpoint r${workspace.checkpointRevision} into ephemeral materialization and now requires local reconciliation.`,
  };
}

export function reconcileSession(
  state: PrototypeState,
  sessionId: string,
  options: { interruptBeforeCommit?: boolean } = {},
): PrototypeResult {
  const next = cloneState(state);
  next.tick += 1;
  const session = next.sessions[sessionId];
  const workspace = session ? next.workspaces[session.workspaceId] : undefined;
  if (!session || !workspace) {
    return { state: next, message: `Unknown session ${sessionId}.` };
  }
  if (
    session.status !== "reconciling" ||
    session.generation !== workspace.acceptedGeneration ||
    session.expectedCheckpointRevision !== workspace.checkpointRevision
  ) {
    session.status = "quarantined";
    session.reason = "stale_generation_or_checkpoint";
    if (session.generation === workspace.acceptedGeneration) {
      workspace.status = "quarantined";
    }
    return {
      state: next,
      message:
        "Reconcile rejected: the transport no longer owns the accepted generation/checkpoint pair.",
    };
  }

  if (options.interruptBeforeCommit) {
    session.status = "recovering";
    workspace.status = "recovering";
    return {
      state: next,
      message: `Publication interrupted; durable checkpoint r${workspace.checkpointRevision} is still active.`,
    };
  }

  const changed = digestManifest(session.localManifest) !== digestManifest(workspace.checkpoint);
  if (changed) {
    workspace.checkpointRevision += 1;
    workspace.checkpoint = cloneManifest(session.localManifest);
  }
  workspace.status = "ready";
  workspace.lastSyncTick = next.tick;
  delete workspace.lastRejectedAttach;
  session.status = "ready";
  session.expectedCheckpointRevision = workspace.checkpointRevision;
  session.materializedManifest = cloneManifest(session.localManifest);
  next.receipts[receiptKey(session.clientFingerprint, workspace.projectFingerprint)] =
    receiptFrom(workspace);
  return {
    state: next,
    sessionId,
    workspaceId: workspace.workspaceId,
    message: changed
      ? `Local authority won reconciliation; checkpoint advanced atomically to r${workspace.checkpointRevision}.`
      : `Local and checkpoint manifests match; checkpoint r${workspace.checkpointRevision} remains active.`,
  };
}

export function retryRecovery(state: PrototypeState, sessionId: string): PrototypeResult {
  const next = cloneState(state);
  const session = next.sessions[sessionId];
  if (!session || session.status !== "recovering") {
    return { state: next, message: `Session ${sessionId} is not recovering.` };
  }
  session.status = "reconciling";
  next.workspaces[session.workspaceId]!.status = "reconciling";
  return reconcileSession(next, sessionId);
}

export function replaceLocalManifest(
  state: PrototypeState,
  sessionId: string,
  manifest: Manifest,
): PrototypeResult {
  const next = cloneState(state);
  next.tick += 1;
  const session = next.sessions[sessionId];
  if (!session) {
    return { state: next, message: `Unknown session ${sessionId}.` };
  }
  session.localManifest = cloneManifest(manifest);
  if (session.status === "ready") {
    session.status = "reconciling";
    next.workspaces[session.workspaceId]!.status = "reconciling";
  }
  return {
    state: next,
    sessionId,
    workspaceId: session.workspaceId,
    message:
      "Changed only the local manifest; the durable checkpoint is untouched until reconciliation.",
  };
}

export function restartRuntime(state: PrototypeState): PrototypeResult {
  const next = cloneState(state);
  next.tick += 1;
  next.sessions = {};
  for (const workspace of Object.values(next.workspaces)) {
    workspace.status = "disconnected";
    delete workspace.lastRejectedAttach;
  }
  return {
    state: next,
    message:
      "Runtime restarted: all transports and materializations were discarded; durable workspaces, checkpoints, generations, and local receipts survived.",
  };
}

export function copyReceipt(
  state: PrototypeState,
  input: {
    fromClientFingerprint: string;
    toClientFingerprint: string;
    projectFingerprint: string;
  },
): PrototypeResult {
  const next = cloneState(state);
  next.tick += 1;
  const source = next.receipts[receiptKey(input.fromClientFingerprint, input.projectFingerprint)];
  if (!source) {
    return { state: next, message: "Source client has no binding receipt." };
  }
  next.receipts[receiptKey(input.toClientFingerprint, input.projectFingerprint)] = {
    ...source,
  };
  return {
    state: next,
    workspaceId: source.workspaceId,
    message:
      "Copied a deliberately shared receipt to model a second clone; subsequent generation changes can make either copy stale.",
  };
}

export function transferAuthority(
  state: PrototypeState,
  input: {
    clientFingerprint: string;
    projectFingerprint: string;
    workspaceId: string;
    localManifest: Manifest;
  },
): PrototypeResult {
  const next = cloneState(state);
  next.tick += 1;
  const workspace = next.workspaces[input.workspaceId];
  if (!workspace || workspace.projectFingerprint !== input.projectFingerprint) {
    return { state: next, message: "Workspace/project identity mismatch." };
  }
  for (const session of Object.values(next.sessions)) {
    if (session.workspaceId === workspace.workspaceId) {
      session.status = "quarantined";
      session.reason = "authority_transferred";
    }
  }
  workspace.acceptedGeneration += 1;
  workspace.authorityClientFingerprint = input.clientFingerprint;
  workspace.status = "reconciling";
  workspace.acceptedAttachId = `authority-transfer-${next.tick}`;
  delete workspace.lastRejectedAttach;
  const sessionId = `transport-${next.nextSession++}`;
  next.sessions[sessionId] = {
    sessionId,
    workspaceId: workspace.workspaceId,
    clientFingerprint: input.clientFingerprint,
    generation: workspace.acceptedGeneration,
    expectedCheckpointRevision: workspace.checkpointRevision,
    localManifest: cloneManifest(input.localManifest),
    materializedManifest: cloneManifest(workspace.checkpoint),
    status: "reconciling",
  };
  next.receipts[receiptKey(input.clientFingerprint, input.projectFingerprint)] =
    receiptFrom(workspace);
  return {
    state: next,
    sessionId,
    workspaceId: workspace.workspaceId,
    message: `Operator-authorized local transfer accepted generation ${workspace.acceptedGeneration}; local reconciliation is still required before ready.`,
  };
}

export function digestManifest(manifest: Manifest): string {
  const stable = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 12);
}

export function summarizeState(state: PrototypeState): unknown {
  return {
    tick: state.tick,
    workspaces: Object.fromEntries(
      Object.entries(state.workspaces).map(([id, workspace]) => [
        id,
        {
          projectFingerprint: workspace.projectFingerprint,
          authorityClientFingerprint: workspace.authorityClientFingerprint,
          acceptedGeneration: workspace.acceptedGeneration,
          checkpointRevision: workspace.checkpointRevision,
          checkpointDigest: digestManifest(workspace.checkpoint),
          status: workspace.status,
          lastSyncTick: workspace.lastSyncTick,
          acceptedAttachId: workspace.acceptedAttachId,
          lastRejectedAttach: workspace.lastRejectedAttach,
        },
      ]),
    ),
    transports: Object.fromEntries(
      Object.entries(state.sessions).map(([id, session]) => [
        id,
        {
          workspaceId: session.workspaceId,
          clientFingerprint: session.clientFingerprint,
          generation: session.generation,
          expectedCheckpointRevision: session.expectedCheckpointRevision,
          localDigest: digestManifest(session.localManifest),
          materializedDigest: digestManifest(session.materializedManifest),
          status: session.status,
          reason: session.reason,
        },
      ]),
    ),
    localReceipts: Object.fromEntries(
      Object.entries(state.receipts).map(([key, receipt]) => [key, receipt]),
    ),
  };
}

function receiptFrom(workspace: DurableWorkspace): BindingReceipt {
  return {
    workspaceId: workspace.workspaceId,
    acceptedGeneration: workspace.acceptedGeneration,
    checkpointRevision: workspace.checkpointRevision,
    manifestDigest: digestManifest(workspace.checkpoint),
  };
}

function receiptKey(clientFingerprint: string, projectFingerprint: string): string {
  return `${clientFingerprint}:${projectFingerprint}`;
}

function cloneState(state: PrototypeState): PrototypeState {
  return structuredClone(state);
}

function cloneManifest(manifest: Manifest): Manifest {
  return { ...manifest };
}
