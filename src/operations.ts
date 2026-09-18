/**
 * Centralized operation guard and execution coordination.
 * 
 * Invariants:
 * 1. Mutual exclusivity for installation mutators (sync, repair, move, mod-mutations, launch).
 * 2. Operation ownership: an operation owns an AbortController and unique ID.
 * 3. Settlement guarantee: guard is held until all async writers, workers, and cleanup settle.
 * 4. Stale callback & destroyed window protection: throttled progress rejects callbacks from finished operations.
 */

import { GameRunner } from "./game-runner";

export type LauncherOperationType = "sync" | "repair" | "move" | "launch" | "mod-mutation";

export interface ActiveOperationInfo {
  id: string;
  type: LauncherOperationType;
  startTime: number;
  description?: string;
}

export interface OperationScope {
  id: string;
  type: LauncherOperationType;
  signal: AbortSignal;
  abort: (reason?: any) => void;
  release: () => void;
  createThrottledProgress: <T>(
    sender: (data: T) => void,
    intervalMs?: number,
    isTerminal?: (data: T) => boolean
  ) => (data: T, forceImmediate?: boolean) => void;
}

export class OperationBusyError extends Error {
  readonly isMainOwnedError = true;
  constructor(public readonly currentOperation: ActiveOperationInfo, requestedType: string) {
    super(`Cannot start '${requestedType}': operation '${currentOperation.type}' is currently in progress.`);
    this.name = "OperationBusyError";
  }
}

export class GameRunningConflictError extends Error {
  readonly isMainOwnedError = true;
  constructor(operation: string) {
    super(`Cannot perform '${operation}' while Minecraft is running.`);
    this.name = "GameRunningConflictError";
  }
}

let activeOperation: {
  id: string;
  type: LauncherOperationType;
  startTime: number;
  description?: string;
  abortController: AbortController;
  settled: boolean;
} | null = null;

let opSeq = 0;
let blockedReason: string | null = null;

export class OperationCoordinator {
  /**
   * Permanently blocks mutations if startup recovery encounters an unresolved state.
   */
  static blockMutations(reason: string): void {
    blockedReason = reason;
  }

  static isBlocked(): boolean {
    return blockedReason !== null;
  }

  static getBlockedReason(): string | null {
    return blockedReason;
  }

  /**
   * Acquires the exclusive operation guard for an operation type.
   * Throws Error if mutations are blocked due to recovery failure.
   * Throws OperationBusyError if another operation is active.
   * Throws GameRunningConflictError if Minecraft is running and operation affects installation.
   */
  static acquire(type: LauncherOperationType, description?: string): OperationScope {
    if (blockedReason) {
      throw new Error(`Launcher operations are blocked due to an unresolved startup recovery failure: ${blockedReason}`);
    }

    if (activeOperation && !activeOperation.settled) {
      throw new OperationBusyError(
        {
          id: activeOperation.id,
          type: activeOperation.type,
          startTime: activeOperation.startTime,
          description: activeOperation.description,
        },
        type
      );
    }

    if (GameRunner.isGameRunning()) {
      throw new GameRunningConflictError(type);
    }

    const opId = `op-${Date.now()}-${++opSeq}`;
    const abortController = new AbortController();

    const currentOp = {
      id: opId,
      type,
      startTime: Date.now(),
      description,
      abortController,
      settled: false,
    };

    activeOperation = currentOp;

    const release = () => {
      if (activeOperation?.id === opId) {
        currentOp.settled = true;
        activeOperation = null;
      }
    };

    const abort = (reason?: any) => {
      if (!abortController.signal.aborted) {
        abortController.abort(reason || new Error(`Operation ${opId} was cancelled.`));
      }
    };

    const createThrottledProgress = <T>(
      sender: (data: T) => void,
      intervalMs = 100,
      isTerminal?: (data: T) => boolean
    ) => {
      let lastSent = 0;
      let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingData: T | null = null;

      return (data: T, forceImmediate = false): void => {
        // Discard progress if operation is settled or not current
        if (currentOp.settled || activeOperation?.id !== opId) {
          return;
        }

        const now = Date.now();
        const terminal = isTerminal ? isTerminal(data) : false;

        if (terminal || forceImmediate || now - lastSent >= intervalMs) {
          if (scheduledTimer) {
            clearTimeout(scheduledTimer);
            scheduledTimer = null;
          }
          pendingData = null;
          lastSent = now;
          sender(data);
        } else {
          pendingData = data;
          if (!scheduledTimer) {
            scheduledTimer = setTimeout(() => {
              scheduledTimer = null;
              if (!currentOp.settled && activeOperation?.id === opId && pendingData !== null) {
                lastSent = Date.now();
                const toSend = pendingData;
                pendingData = null;
                sender(toSend);
              }
            }, intervalMs - (now - lastSent));
          }
        }
      };
    };

    return {
      id: opId,
      type,
      signal: abortController.signal,
      abort,
      release,
      createThrottledProgress,
    };
  }

  /**
   * Asserts that mutations are safe to perform.
   * Called by ClientModManager and settings modifiers.
   */
  static assertCanMutate(operationName = "modify installation"): void {
    if (blockedReason) {
      throw new Error(`Cannot perform '${operationName}': launcher operations are blocked due to an unresolved startup recovery failure: ${blockedReason}`);
    }
    if (activeOperation && !activeOperation.settled) {
      throw new OperationBusyError(
        {
          id: activeOperation.id,
          type: activeOperation.type,
          startTime: activeOperation.startTime,
          description: activeOperation.description,
        },
        operationName
      );
    }
    if (GameRunner.isGameRunning()) {
      throw new GameRunningConflictError(operationName);
    }
  }

  static getActive(): ActiveOperationInfo | null {
    if (!activeOperation || activeOperation.settled) return null;
    return {
      id: activeOperation.id,
      type: activeOperation.type,
      startTime: activeOperation.startTime,
      description: activeOperation.description,
    };
  }

  static isBusy(): boolean {
    return activeOperation !== null && !activeOperation.settled;
  }

  static resetForTesting(): void {
    blockedReason = null;
    if (activeOperation) {
      activeOperation.settled = true;
      activeOperation = null;
    }
  }
}

/**
 * Safely dispatches an IPC message to an Electron BrowserWindow / WebContents,
 * preventing unhandled exceptions if the window or its webContents has been destroyed.
 */
export function safeSend(
  window: { isDestroyed?: () => boolean; webContents?: { isDestroyed?: () => boolean; send: (channel: string, ...args: any[]) => void } } | null | undefined,
  channel: string,
  ...args: any[]
): boolean {
  if (!window) return false;
  try {
    if (typeof window.isDestroyed === "function" && window.isDestroyed()) return false;
    if (!window.webContents) return false;
    if (typeof window.webContents.isDestroyed === "function" && window.webContents.isDestroyed()) return false;
    window.webContents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

