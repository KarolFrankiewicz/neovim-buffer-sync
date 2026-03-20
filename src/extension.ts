import * as vscode from "vscode";
import { NeovimConnection } from "./neovim-connection";
import { SyncManager } from "./sync-manager";

let nvimConnection: NeovimConnection | null = null;
let syncManager: SyncManager | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let outputChannel: vscode.OutputChannel;
let terminalWatcher: vscode.Disposable | null = null;
let autoConnectRetryTimer: ReturnType<typeof setInterval> | null = null;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Neovim Buffer Sync");
  context.subscriptions.push(outputChannel);

  nvimConnection = new NeovimConnection();
  setupConnectionListeners();

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = "nvimBufferSync.showStatus";
  updateStatusBar(false);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("nvimBufferSync.connect", connectCommand)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nvimBufferSync.disconnect",
      disconnectCommand
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nvimBufferSync.showStatus",
      showStatusCommand
    )
  );

  const config = vscode.workspace.getConfiguration("nvimBufferSync");
  if (config.get<boolean>("autoConnect", true)) {
    autoConnect();
    startAutoConnectRetryLoop();
  }

  // Watch for new terminals that might be running Neovim
  terminalWatcher = vscode.window.onDidOpenTerminal(() => {
    if (!nvimConnection?.connected) {
      setTimeout(() => autoConnect(), 2000);
    }
  });
  context.subscriptions.push(terminalWatcher);

  outputChannel.appendLine("Neovim Buffer Sync extension activated");
}

export function deactivate(): void {
  syncManager?.dispose();
  nvimConnection?.disconnect();
  outputChannel?.appendLine("Neovim Buffer Sync extension deactivated");
  if (autoConnectRetryTimer) {
    clearInterval(autoConnectRetryTimer);
    autoConnectRetryTimer = null;
  }
}

function setupConnectionListeners(): void {
  if (!nvimConnection) return;

  nvimConnection.on("connected", (socketPath: string) => {
    outputChannel.appendLine(`Connected to Neovim at ${socketPath}`);
    updateStatusBar(true);
    vscode.window.showInformationMessage(
      `Neovim Buffer Sync: Connected to ${socketPath}`
    );
  });

  nvimConnection.on("disconnected", () => {
    outputChannel.appendLine("Disconnected from Neovim");
    updateStatusBar(false);
    syncManager?.dispose();
    syncManager = null;

    // Try to reconnect after a delay
    const config = vscode.workspace.getConfiguration("nvimBufferSync");
    if (config.get<boolean>("autoConnect", true)) {
      setTimeout(() => autoConnect(), 3000);
    }
  });

  nvimConnection.on("error", (err: Error) => {
    outputChannel.appendLine(`Neovim connection error: ${err.message}`);
  });
}

async function autoConnect(): Promise<void> {
  if (!nvimConnection || nvimConnection.connected) return;

  const config = vscode.workspace.getConfiguration("nvimBufferSync");
  const configuredSocket = config.get<string>("socketPath", "");

  if (configuredSocket) {
    outputChannel.appendLine(
      `Trying configured socket: ${configuredSocket}`
    );
    const success = await nvimConnection.connect(configuredSocket);
    if (success) {
      startSync();
      return;
    }
  }

  // Auto-discover Neovim sockets
  outputChannel.appendLine("Auto-discovering Neovim sockets...");
  const sockets = await NeovimConnection.discoverSockets();
  outputChannel.appendLine(`Found ${sockets.length} candidate socket(s)`);

  for (const socket of sockets) {
    const alive = await NeovimConnection.probeSocket(socket);
    if (alive) {
      outputChannel.appendLine(`Probed socket ${socket} - alive`);
      const success = await nvimConnection.connect(socket);
      if (success) {
        startSync();
        return;
      }
    }
  }

  outputChannel.appendLine(
    "No Neovim instance found. Start Neovim with --listen or set socketPath in settings."
  );
}

function startAutoConnectRetryLoop(): void {
  if (autoConnectRetryTimer) return;

  // Keep retrying while disconnected (e.g. Neovim restarted, socket reappeared later).
  // Do NOT stop the interval when connected — that prevented reconnect after the first session.
  autoConnectRetryTimer = setInterval(() => {
    if (!nvimConnection || nvimConnection.connected) return;
    void autoConnect();
  }, 3000);
}

function startSync(): void {
  if (!nvimConnection) return;

  syncManager?.dispose();
  syncManager = new SyncManager(nvimConnection);
  syncManager.start();
  outputChannel.appendLine("Buffer synchronization started");
}

async function connectCommand(): Promise<void> {
  if (!nvimConnection) return;

  if (nvimConnection.connected) {
    const choice = await vscode.window.showInformationMessage(
      `Already connected to ${nvimConnection.socket}. Reconnect?`,
      "Reconnect",
      "Cancel"
    );
    if (choice !== "Reconnect") return;
    await nvimConnection.disconnect();
    syncManager?.dispose();
    syncManager = null;
  }

  const sockets = await NeovimConnection.discoverSockets();
  const items: vscode.QuickPickItem[] = sockets.map((s) => ({
    label: s,
    description: "Discovered socket",
  }));
  items.push({
    label: "$(edit) Enter custom path...",
    description: "",
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a Neovim socket to connect to",
  });

  if (!picked) return;

  let socketPath: string;
  if (picked.label.includes("Enter custom path")) {
    const input = await vscode.window.showInputBox({
      prompt: "Enter the Neovim socket path",
      placeHolder: "/tmp/nvim.sock",
    });
    if (!input) return;
    socketPath = input;
  } else {
    socketPath = picked.label;
  }

  const success = await nvimConnection.connect(socketPath);
  if (success) {
    startSync();
  } else {
    vscode.window.showErrorMessage(
      `Failed to connect to Neovim at ${socketPath}`
    );
  }
}

async function disconnectCommand(): Promise<void> {
  if (!nvimConnection?.connected) {
    vscode.window.showInformationMessage("Not connected to Neovim");
    return;
  }

  syncManager?.dispose();
  syncManager = null;
  await nvimConnection.disconnect();
  updateStatusBar(false);
  vscode.window.showInformationMessage("Disconnected from Neovim");
}

async function showStatusCommand(): Promise<void> {
  const connected = nvimConnection?.connected ?? false;
  const socket = nvimConnection?.socket ?? "N/A";

  if (connected) {
    const buffers = (await nvimConnection?.getBufferList()) ?? [];
    const message = [
      `Status: Connected`,
      `Socket: ${socket}`,
      `Neovim buffers: ${buffers.length}`,
      `VS Code tabs: ${vscode.window.tabGroups.all.flatMap((g) => g.tabs).length}`,
    ].join("\n");

    const action = await vscode.window.showInformationMessage(
      message,
      "Disconnect",
      "Refresh"
    );
    if (action === "Disconnect") {
      await disconnectCommand();
    } else if (action === "Refresh") {
      await showStatusCommand();
    }
  } else {
    const action = await vscode.window.showInformationMessage(
      "Neovim Buffer Sync: Not connected",
      "Connect"
    );
    if (action === "Connect") {
      await connectCommand();
    }
  }
}

function updateStatusBar(connected: boolean): void {
  if (!statusBarItem) return;
  if (connected) {
    statusBarItem.text = "$(plug) Nvim Sync";
    statusBarItem.tooltip = `Connected to Neovim at ${nvimConnection?.socket}`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = "$(debug-disconnect) Nvim Sync";
    statusBarItem.tooltip = "Not connected to Neovim. Click to view status.";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }
}
