import { NeovimClient, attach } from "neovim";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";

export class NeovimConnection extends EventEmitter {
  private client: NeovimClient | null = null;
  private _connected = false;
  private socketPath: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  get connected(): boolean {
    return this._connected;
  }

  get socket(): string | null {
    return this.socketPath;
  }

  async connect(socketPath: string): Promise<boolean> {
    if (this._connected) {
      await this.disconnect();
    }

    try {
      const alive = await NeovimConnection.probeSocket(socketPath);
      if (!alive) {
        throw new Error(`No Neovim instance responding at ${socketPath}`);
      }

      this.client = attach({ socket: socketPath });
      this.socketPath = socketPath;
      this._connected = true;

      // When Neovim exits, transport emits detach → client emits 'disconnect'.
      // Without this, _connected stays true and the extension never reconnects.
      this.client.once("disconnect", () => {
        this.handleDisconnect();
      });

      // Verify it's actually Neovim by calling a real API method
      await this.client.commandOutput("echo 'nvim-buffer-sync connected'");

      await this.setupNotifications();
      this.emit("connected", socketPath);
      return true;
    } catch (err) {
      this._connected = false;
      this.client = null;
      this.emit("error", err);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        // close() drops the RPC connection without killing Neovim.
        // quit() sends :qa! which terminates Neovim — never use it.
        await this.client.close();
      } catch {
        // already disconnected
      }
      this.client = null;
    }
    this._connected = false;
    this.socketPath = null;
  }

  private handleDisconnect(): void {
    if (!this._connected) return;
    this._connected = false;
    this.client = null;
    this.socketPath = null;
    this.emit("disconnected");
  }

  private async setupNotifications(): Promise<void> {
    if (!this.client) return;

    this.client.on("notification", (method: string, args: unknown[]) => {
      if (method === "nvim_buf_sync_open") {
        const filePath = args[0] as string;
        this.emit("buffer-opened", filePath);
      } else if (method === "nvim_buf_sync_close") {
        const filePath = args[0] as string;
        this.emit("buffer-closed", filePath);
      } else if (method === "nvim_buf_sync_list") {
        const buffers = args[0] as string[];
        this.emit("buffer-list", buffers);
      }
    });

    const luaSetup = `
      local group = vim.api.nvim_create_augroup('VSCodeBufferSync', { clear = true })

      vim.api.nvim_create_autocmd({'BufAdd', 'BufReadPost'}, {
        group = group,
        callback = function(ev)
          local bufname = vim.api.nvim_buf_get_name(ev.buf)
          bufname = vim.fn.fnamemodify(bufname, ':p')
          if bufname ~= '' and vim.fn.filereadable(bufname) == 1 then
            vim.rpcnotify(0, 'nvim_buf_sync_open', bufname)
          end
        end,
      })

      vim.api.nvim_create_autocmd('BufDelete', {
        group = group,
        callback = function(ev)
          local bufname = vim.api.nvim_buf_get_name(ev.buf)
          bufname = vim.fn.fnamemodify(bufname, ':p')
          if bufname ~= '' then
            vim.rpcnotify(0, 'nvim_buf_sync_close', bufname)
          end
        end,
      })
    `;

    await this.client.lua(luaSetup);
  }

  async getBufferList(): Promise<string[]> {
    if (!this.client) return [];

    const lua = `
      local bufs = {}
      for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.bo[b].buflisted then
          local name = vim.api.nvim_buf_get_name(b)
          name = vim.fn.fnamemodify(name, ':p')
          if name ~= '' and vim.fn.filereadable(name) == 1 then
            table.insert(bufs, name)
          end
        end
      end
      return bufs
    `;

    try {
      return (await this.client.lua(lua)) as string[];
    } catch {
      return [];
    }
  }

  async openBuffer(filePath: string): Promise<void> {
    if (!this.client) return;

    const absPath = path.resolve(filePath);
    try {
      await this.client.command(`badd ${absPath.replace(/ /g, "\\ ")}`);
    } catch (err) {
      this.emit("error", err);
    }
  }

  async closeBuffer(filePath: string): Promise<void> {
    if (!this.client) return;

    const absPath = path.resolve(filePath);
    try {
      await this.client.command(
        `silent! bdelete ${absPath.replace(/ /g, "\\ ")}`
      );
    } catch (err) {
      this.emit("error", err);
    }
  }

  /**
   * Remove a buffer that was only used like a "preview" in the sync flow.
   * Safe: skips if modified, invalid, or shown in any window.
   */
  async tryDeletePreviewBufferIfSafe(filePath: string): Promise<boolean> {
    if (!this.client) return false;

    const absPath = path.resolve(filePath);
    const pathLiteral = JSON.stringify(absPath);

    const lua = `
      local p = vim.fn.fnamemodify(${pathLiteral}, ':p')
      local buf = vim.fn.bufnr(p)
      if buf == -1 or not vim.api.nvim_buf_is_valid(buf) then
        return false
      end
      if vim.bo[buf].modified then
        return false
      end
      if vim.bo[buf].buftype ~= '' then
        return false
      end
      local ok = pcall(vim.api.nvim_buf_delete, buf, { force = false })
      return ok
    `;

    try {
      return Boolean(await this.client.lua(lua));
    } catch {
      return false;
    }
  }

  /**
   * Discover Neovim sockets. Returns candidates that are nvim-prefixed
   * and respond to a TCP connection (lightweight, non-destructive).
   */
  static async discoverSockets(): Promise<string[]> {
    const raw = await NeovimConnection.findSocketCandidates();
    const verified: string[] = [];

    for (const candidate of raw) {
      if (await NeovimConnection.probeSocket(candidate)) {
        verified.push(candidate);
      }
    }

    return verified;
  }

  /**
   * Gather socket file paths that *might* be Neovim.
   * Intentionally narrow: only nvim-prefixed entries.
   */
  private static async findSocketCandidates(): Promise<string[]> {
    // Prefer fixed socket name because users typically run:
    //   nvim --listen /tmp/nvim-vscode.sock
    const fixedPreferred = [
      "/tmp/nvim-vscode.sock",
      "/private/tmp/nvim-vscode.sock",
    ].filter((p) => NeovimConnection.fileExists(p));
    if (fixedPreferred.length > 0) return fixedPreferred;

    // NVIM_LISTEN_ADDRESS (if set) is the next best thing.
    const nvimAddr = process.env.NVIM_LISTEN_ADDRESS;
    if (nvimAddr) return [nvimAddr];

    // As a fallback, do a very narrow scan:
    // Look for Neovim auto-sockets in /tmp like /tmp/nvimXXXXXX/0
    // (we only accept inner socket named exactly "0").
    const candidates: string[] = [];
    const dirsToScan = ["/tmp", "/private/tmp"];

    for (const dir of dirsToScan) {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (!entry.startsWith("nvim")) continue;
          const possibleDir = path.join(dir, entry);
          try {
            const stat = fs.statSync(possibleDir);
            if (!stat.isDirectory()) continue;

            const innerSock = path.join(possibleDir, "0");
            if (NeovimConnection.fileExists(innerSock)) {
              candidates.push(innerSock);
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore missing dir
      }
    }

    return candidates;
  }

  private static fileExists(p: string): boolean {
    try {
      fs.statSync(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Quick TCP-level probe (does NOT verify Neovim RPC).
   */
  static async probeSocket(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);

      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }
}
