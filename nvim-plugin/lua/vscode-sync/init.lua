-- vscode-sync: Neovim plugin for buffer synchronization with VS Code
--
-- This plugin works alongside the VS Code extension "nvim-buffer-sync".
-- The extension injects autocommands via RPC when it connects, but this
-- plugin can also be loaded standalone to queue buffer events that the
-- extension will pick up on connection.

local M = {}

M.config = {
  -- Patterns to exclude from sync (Neovim special buffers)
  ignored_patterns = {
    "^term://",
    "^fugitive://",
    "^health://",
    "^man://",
    "^gitsigns://",
    "^diffview://",
    "^NvimTree",
    "^neo%-tree",
    "^Trouble",
    "^TelescopePrompt$",
    "^%[",
  },
}

local function should_sync(bufname)
  if bufname == "" then
    return false
  end

  if vim.fn.filereadable(bufname) ~= 1 then
    return false
  end

  for _, pattern in ipairs(M.config.ignored_patterns) do
    if bufname:match(pattern) then
      return false
    end
  end

  return true
end

function M.notify_buffer_open(bufname)
  local abs = vim.fn.fnamemodify(bufname, ':p')
  if not should_sync(abs) then
    return
  end
  -- rpcnotify channel 0 broadcasts to all subscribers
  vim.rpcnotify(0, "nvim_buf_sync_open", abs)
end

function M.notify_buffer_close(bufname)
  if bufname == "" then
    return
  end
  local abs = vim.fn.fnamemodify(bufname, ':p')
  if abs == "" then
    return
  end
  vim.rpcnotify(0, "nvim_buf_sync_close", abs)
end

function M.send_buffer_list()
  local bufs = {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[b].buflisted then
      local name = vim.api.nvim_buf_get_name(b)
      name = vim.fn.fnamemodify(name, ':p')
      if should_sync(name) then
        table.insert(bufs, name)
      end
    end
  end
  vim.rpcnotify(0, "nvim_buf_sync_list", bufs)
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})

  local group = vim.api.nvim_create_augroup("VSCodeBufferSync", { clear = true })

  vim.api.nvim_create_autocmd({ "BufAdd", "BufReadPost" }, {
    group = group,
    callback = function(ev)
      local bufname = vim.api.nvim_buf_get_name(ev.buf)
      M.notify_buffer_open(bufname)
    end,
  })

  vim.api.nvim_create_autocmd("BufDelete", {
    group = group,
    callback = function(ev)
      local bufname = vim.api.nvim_buf_get_name(ev.buf)
      M.notify_buffer_close(bufname)
    end,
  })

  vim.api.nvim_create_user_command("VSCodeSyncList", function()
    M.send_buffer_list()
  end, { desc = "Send current buffer list to VS Code" })

  vim.api.nvim_create_user_command("VSCodeSyncStatus", function()
    local bufs = {}
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buflisted then
        local name = vim.api.nvim_buf_get_name(b)
        if should_sync(name) then
          table.insert(bufs, vim.fn.fnamemodify(name, ":~:."))
        end
      end
    end
    print("VSCode Sync - Tracked buffers (" .. #bufs .. "):")
    for _, name in ipairs(bufs) do
      print("  " .. name)
    end
  end, { desc = "Show buffers being synced to VS Code" })
end

return M
