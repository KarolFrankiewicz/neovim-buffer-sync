import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { NeovimConnection } from "./neovim-connection";

/** Ignore duplicate VS Code open events right after we mirrored Nvim→VS Code (tab + visible editors fire separately). */
const VSCODE_MIRROR_ECHO_SUPPRESS_MS = 450;

export class SyncManager implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private nvim: NeovimConnection;
  private syncedFromNvim = new Set<string>();
  private syncedFromVscode = new Set<string>();
  /**
   * Paths we added in Neovim via `badd` from VS Code. Used to remove matching
   * buffers when the last VS Code tab for that file closes or a preview is dropped.
   */
  private nvimBuffersOpenedFromVscode = new Set<string>();
  /** Paths currently running `openBuffer` / `:badd` from VS Code (dedupes parallel tab + visible-editor events). */
  private vscodeToNvimInFlight = new Set<string>();
  /** Paths we recently opened in VS Code from Neovim; suppress spurious VS Code→Nvim echoes for a short window. */
  private recentlyMirroredFromNvim = new Map<string, number>();
  private initialSyncDone = false;

  /** Last file we opened as a preview from Neovim (single-slot cleanup). */
  private lastNvimPreviewPath: string | null = null;

  /** Paths we opened in VS Code from Neovim — used to close stale VS Code tabs during reconcile. */
  private vscodeTabsOpenedFromNvim = new Set<string>();

  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  /** Stable refs so we can removeListener on dispose (avoids duplicate handlers after reconnect). */
  private readonly onNvimBufferOpenedBound = (filePath: string): void => {
    void this.handleNvimBufferOpened(filePath);
  };
  private readonly onNvimBufferClosedBound = (filePath: string): void => {
    void this.handleNvimBufferClosed(filePath);
  };
  private readonly onNvimConnectedBound = (): void => {
    void this.doInitialSync();
  };

  constructor(nvim: NeovimConnection) {
    this.nvim = nvim;
  }

  start(): void {
    const config = vscode.workspace.getConfiguration("nvimBufferSync");

    if (config.get<boolean>("syncNvimToVscode", true)) {
      this.startNvimToVscodeSync();
    }

    if (config.get<boolean>("syncVscodeToNvim", true)) {
      this.startVscodeToNvimSync();
    }

    if (this.nvim.connected) {
      void this.doInitialSync();
    }

    this.nvim.on("connected", this.onNvimConnectedBound);
  }

  private startNvimToVscodeSync(): void {
    this.nvim.on("buffer-opened", this.onNvimBufferOpenedBound);
    this.nvim.on("buffer-closed", this.onNvimBufferClosedBound);
  }

  private startVscodeToNvimSync(): void {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          void this.handleVscodeEditorOpened(editor);
        }
      })
    );

    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        const cfg = vscode.workspace.getConfiguration("nvimBufferSync");
        const syncDiff = cfg.get<boolean>("syncDiffAndReviewTabs", true);
        for (const tab of event.opened) {
          for (const fsPath of this.filePathsFromTab(tab, syncDiff)) {
            void this.handleVscodeFileOpened(fsPath);
          }
        }
        for (const tab of event.closed) {
          void this.handleVscodeTabClosed(tab, syncDiff);
        }
      })
    );
  }

  private async doInitialSync(): Promise<void> {
    if (this.initialSyncDone) return;
    this.initialSyncDone = true;

    const buffers = await this.nvim.getBufferList();
    for (const bufPath of buffers) {
      await this.handleNvimBufferOpened(bufPath);
    }

    const cfg = vscode.workspace.getConfiguration("nvimBufferSync");
    const syncDiff = cfg.get<boolean>("syncDiffAndReviewTabs", true);
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        for (const fsPath of this.filePathsFromTab(tab, syncDiff)) {
          await this.handleVscodeFileOpened(fsPath);
        }
      }
    }
  }

  // --- Nvim → VS Code ---

  private async handleNvimBufferOpened(filePath: string): Promise<void> {
    if (!this.isValidSyncPath(filePath)) return;

    const normalized = this.normalizePath(filePath);

    if (this.syncedFromVscode.has(normalized)) {
      this.syncedFromVscode.delete(normalized);
      return;
    }

    if (this.isOpenInVscodeTab(normalized)) return;

    const config = vscode.workspace.getConfiguration("nvimBufferSync");
    const behavior = config.get<string>("openBehavior", "background");

    // Remember whether terminal has focus; we'll restore it to avoid attention grab.
    const terminalWasFocused = isTerminalLikelyFocused();

    log(`Nvim→VSCode(${behavior}): ${normalized}`);
    this.syncedFromNvim.add(normalized);

    try {
      const uri = vscode.Uri.file(normalized);
      const usePreviewSlot = behavior === "preview";

      if (usePreviewSlot) {
        // VS Code preview reuse can leave an extra tab/document behind when
        // focus stays in the terminal. Close our previous preview explicitly.
        await this.closePreviousNvimPreviewIfNeeded(
          normalized,
          terminalWasFocused
        );
      } else {
        this.lastNvimPreviewPath = null;
      }

      if (behavior === "active") {
        await vscode.window.showTextDocument(uri, {
          preview: false,
          preserveFocus: false,
        });
      } else if (behavior === "preview") {
        await vscode.window.showTextDocument(uri, {
          preview: true,
          preserveFocus: true,
        });
      } else {
        // background (default): persistent tab, keep focus in terminal
        await vscode.window.showTextDocument(uri, {
          preview: false,
          preserveFocus: true,
          viewColumn: vscode.ViewColumn.One,
        });
      }

      this.vscodeTabsOpenedFromNvim.add(normalized);

      if (usePreviewSlot) {
        this.lastNvimPreviewPath = normalized;
      }

      // restore terminal focus ASAP to prevent editor panel flash
      if (terminalWasFocused) {
        void restoreTerminalFocusSoon();
      }
    } catch (err) {
      log(`Failed to open in VS Code: ${err}`);
    }
  }

  private async handleNvimBufferClosed(filePath: string): Promise<void> {
    if (!this.isValidSyncPath(filePath)) return;
    const normalized = this.normalizePath(filePath);
    this.nvimBuffersOpenedFromVscode.delete(normalized);
    this.recentlyMirroredFromNvim.delete(normalized);
    this.vscodeTabsOpenedFromNvim.delete(normalized);

    const tab = this.findAnyTabForPath(normalized);
    if (!tab) {
      log(`Nvim→VSCode close skipped (tab already gone): ${normalized}`);
      return;
    }

    if (tab.isDirty) {
      log(`Nvim→VSCode close ignored (dirty): ${normalized}`);
      this.scheduleReconcile();
      return;
    }

    const preserveFocus = isTerminalLikelyFocused();
    try {
      await vscode.window.tabGroups.close(tab, preserveFocus);
      if (this.lastNvimPreviewPath === normalized) {
        this.lastNvimPreviewPath = null;
      }
      log(`Nvim→VSCode closed: ${normalized}`);
    } catch (err) {
      log(`Failed to close in VS Code: ${normalized} (${err})`);
    }
    this.scheduleReconcile();
  }

  private findTabByFilePath(normalizedPath: string): vscode.Tab | undefined {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          if (this.normalizePath(tab.input.uri.fsPath) === normalizedPath) {
            return tab;
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Close the previous Neovim-sync preview tab so preview reuse does not
   * accumulate stray tabs/buffers (common when preserveFocus keeps the terminal focused).
   * Also drops the matching Neovim buffer when safe (see closePreviewBuffersInNvim).
   */
  private async closePreviousNvimPreviewIfNeeded(
    nextPath: string,
    preserveFocus: boolean
  ): Promise<void> {
    const prev = this.lastNvimPreviewPath;
    if (!prev || prev === nextPath) return;

    const cfg = vscode.workspace.getConfiguration("nvimBufferSync");
    const cleanNvim = cfg.get<boolean>("closePreviewBuffersInNvim", true);

    const stillOpen = this.isOpenInVscodeTab(prev);
    const tab = this.findTabByFilePath(prev);

    let mayCleanNvim = false;

    if (!stillOpen) {
      // Preview already replaced or closed in VS Code (in any tab shape).
      mayCleanNvim = true;
      this.lastNvimPreviewPath = null;
    } else if (tab && tab.isPreview && !tab.isDirty) {
      try {
        await vscode.window.tabGroups.close(tab, preserveFocus);
      } catch {
        // ignore
      }
      mayCleanNvim = true;
    }
    // Still open as pinned, dirty, or non–TabInputText (e.g. diff): do not touch.

    if (mayCleanNvim && cleanNvim && this.nvim.connected) {
      const removed = await this.nvim.tryDeletePreviewBufferIfSafe(prev);
      if (removed) {
        log(`Nvim: removed stale preview buffer ${prev}`);
      }
    }
  }

  // --- VS Code → Nvim ---

  private async handleVscodeEditorOpened(
    editor: vscode.TextEditor
  ): Promise<void> {
    const doc = editor.document;
    if (doc.uri.scheme !== "file") return;
    await this.handleVscodeFileOpened(doc.uri.fsPath);
  }

  private async handleVscodeFileOpened(fsPath: string): Promise<void> {
    if (!this.nvim.connected) return;
    if (!this.isValidSyncPath(fsPath)) return;

    const normalized = this.normalizePath(fsPath);

    if (this.syncedFromNvim.has(normalized)) {
      this.syncedFromNvim.delete(normalized);
      this.recentlyMirroredFromNvim.set(normalized, Date.now());
      return;
    }

    if (this.isRecentNvimMirrorEcho(normalized)) {
      return;
    }

    if (this.vscodeToNvimInFlight.has(normalized)) {
      return;
    }

    if (this.nvimBuffersOpenedFromVscode.has(normalized)) {
      return;
    }

    log(`VSCode→Nvim: ${normalized}`);
    this.syncedFromVscode.add(normalized);
    this.vscodeToNvimInFlight.add(normalized);

    try {
      await this.nvim.openBuffer(normalized);
      this.nvimBuffersOpenedFromVscode.add(normalized);
    } catch (err) {
      log(`Failed to open in Neovim: ${err}`);
    } finally {
      this.vscodeToNvimInFlight.delete(normalized);
    }
  }

  private isRecentNvimMirrorEcho(normalized: string): boolean {
    const t = this.recentlyMirroredFromNvim.get(normalized);
    if (t === undefined) return false;
    if (Date.now() - t > VSCODE_MIRROR_ECHO_SUPPRESS_MS) {
      this.recentlyMirroredFromNvim.delete(normalized);
      return false;
    }
    return true;
  }

  /**
   * When a VS Code tab goes away (close, preview replace, etc.), drop the Neovim
   * buffer only if we had added it from VS Code and no tab still shows the file.
   */
  private async handleVscodeTabClosed(
    tab: vscode.Tab,
    includeDiffAndCustom: boolean
  ): Promise<void> {
    if (!this.nvim.connected) return;

    for (const fsPath of this.filePathsFromTab(tab, includeDiffAndCustom)) {
      if (!this.isValidSyncPath(fsPath)) continue;
      const normalized = this.normalizePath(fsPath);
      this.recentlyMirroredFromNvim.delete(normalized);
      this.vscodeTabsOpenedFromNvim.delete(normalized);

      if (!this.nvimBuffersOpenedFromVscode.has(normalized)) continue;
      if (this.isOpenInVscodeTab(normalized)) continue;

      if (tab.isDirty) {
        log(`VSCode tab closed with unsaved changes → Nvim buffer kept: ${normalized}`);
        continue;
      }

      this.nvimBuffersOpenedFromVscode.delete(normalized);
      const removed = await this.nvim.tryDeletePreviewBufferIfSafe(normalized);
      if (removed) {
        log(`VSCode tab gone → Nvim buffer removed: ${normalized}`);
      }
    }
    this.scheduleReconcile();
  }

  // --- Post-close reconciliation ---

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcileSync();
    }, 500);
  }

  /**
   * After any close event, compare both sides and clean up orphaned entries:
   * - Files closed in VS Code but still in Neovim → remove from Neovim
   * - Files closed in Neovim but still in VS Code → close the VS Code tab
   */
  private async reconcileSync(): Promise<void> {
    if (!this.nvim.connected) return;

    const nvimBufferPaths = await this.nvim.getBufferList();
    const nvimBuffers = new Set(nvimBufferPaths.map((p) => this.normalizePath(p)));

    // VS Code → Neovim: remove Neovim buffers for files no longer in VS Code
    for (const normalized of [...this.nvimBuffersOpenedFromVscode]) {
      if (this.isOpenInVscodeTab(normalized)) continue;
      this.nvimBuffersOpenedFromVscode.delete(normalized);
      if (!nvimBuffers.has(normalized)) continue;
      const removed = await this.nvim.tryDeletePreviewBufferIfSafe(normalized);
      if (removed) {
        log(`Reconcile VSCode→Nvim: removed stale buffer ${normalized}`);
      }
    }

    // Neovim → VS Code: close VS Code tabs for files no longer in Neovim
    for (const normalized of [...this.vscodeTabsOpenedFromNvim]) {
      if (nvimBuffers.has(normalized)) continue;
      this.vscodeTabsOpenedFromNvim.delete(normalized);
      const tab = this.findAnyTabForPath(normalized);
      if (!tab || tab.isDirty) continue;
      const preserveFocus = isTerminalLikelyFocused();
      try {
        await vscode.window.tabGroups.close(tab, preserveFocus);
        log(`Reconcile Nvim→VSCode: closed stale tab ${normalized}`);
      } catch {
        // ignore
      }
    }
  }

  // --- Filtering ---

  private isValidSyncPath(filePath: string): boolean {
    if (!filePath || !path.isAbsolute(filePath)) return false;

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return false;
    } catch {
      return false;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const inWorkspace = workspaceFolders.some((wf) =>
        this.normalizePath(filePath).startsWith(
          this.normalizePath(wf.uri.fsPath)
        )
      );
      if (!inWorkspace) return false;
    }

    const config = vscode.workspace.getConfiguration("nvimBufferSync");
    const ignoredPatterns = config.get<string[]>("ignoredPatterns", [
      "term://",
      "fugitive://",
      "health://",
      "man://",
    ]);
    for (const pattern of ignoredPatterns) {
      if (filePath.includes(pattern)) return false;
    }

    if (filePath.includes(".git/")) return false;
    if (filePath.includes("extension-output")) return false;
    if (filePath.includes(".cursor/")) return false;

    return true;
  }

  /** First tab that shows this file (plain editor, diff side, etc.) — matches `syncDiffAndReviewTabs`. */
  private findAnyTabForPath(normalizedPath: string): vscode.Tab | undefined {
    const cfg = vscode.workspace.getConfiguration("nvimBufferSync");
    const syncDiff = cfg.get<boolean>("syncDiffAndReviewTabs", true);
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        for (const p of this.filePathsFromTab(tab, syncDiff)) {
          if (this.normalizePath(p) === normalizedPath) {
            return tab;
          }
        }
      }
    }
    return undefined;
  }

  private isOpenInVscodeTab(normalizedPath: string): boolean {
    return this.findAnyTabForPath(normalizedPath) !== undefined;
  }

  /**
   * Collect on-disk paths represented by a tab (plain editor, diff/review, some custom editors).
   */
  private filePathsFromTab(
    tab: vscode.Tab,
    includeDiffAndCustom: boolean
  ): string[] {
    const out: string[] = [];
    const addUri = (u: vscode.Uri | undefined): void => {
      if (u?.scheme === "file" && u.fsPath) {
        out.push(this.normalizePath(u.fsPath));
      }
    };

    if (tab.input instanceof vscode.TabInputText) {
      addUri(tab.input.uri);
      return dedupePaths(out);
    }

    if (includeDiffAndCustom && tab.input instanceof vscode.TabInputTextDiff) {
      addUri(tab.input.original);
      addUri(tab.input.modified);
      return dedupePaths(out);
    }

    if (includeDiffAndCustom && tab.input instanceof vscode.TabInputCustom) {
      addUri(tab.input.uri);
      return dedupePaths(out);
    }

    return out;
  }

  private normalizePath(filePath: string): string {
    return path.resolve(filePath);
  }

  dispose(): void {
    this.nvim.removeListener("buffer-opened", this.onNvimBufferOpenedBound);
    this.nvim.removeListener("buffer-closed", this.onNvimBufferClosedBound);
    this.nvim.removeListener("connected", this.onNvimConnectedBound);

    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.syncedFromNvim.clear();
    this.syncedFromVscode.clear();
    this.nvimBuffersOpenedFromVscode.clear();
    this.vscodeToNvimInFlight.clear();
    this.recentlyMirroredFromNvim.clear();
    this.vscodeTabsOpenedFromNvim.clear();
    this.initialSyncDone = false;
    this.lastNvimPreviewPath = null;
  }
}

// --- Helpers ---

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isTerminalLikelyFocused(): boolean {
  // activeTerminal often remains set even if focus moved to editor,
  // so we also require there to be no active text editor.
  return vscode.window.activeTerminal !== undefined && !vscode.window.activeTextEditor;
}

async function restoreTerminalFocusSoon(): Promise<void> {
  // Restore as soon as VS Code finishes the open operation.
  await new Promise((r) => setTimeout(r, 0));
  await vscode.commands.executeCommand("workbench.action.terminal.focus");
}

let _outputChannel: vscode.OutputChannel | null = null;
function log(msg: string): void {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel("Neovim Buffer Sync");
  }
  _outputChannel.appendLine(msg);
}
