# AgentSwitch on a Linux desktop

The window of a Linux node that has a desktop (docs/linux-app-v0.md): the node's own Terminals page in Electron, signed
in with the local token, a tray item and desktop notifications from `GET /live`. The service stays the keeper's
(systemd); closing or quitting the window leaves it and its terminals running.

- `scripts/run.sh` starts it with the system's Electron (`ELECTRON=` names another). `AGENTSWITCH_HOME` and
  `AGENTSWITCH_URL` point it at another data folder or service.
- `scripts/run.sh --hidden` starts in the tray (the login item does this).
- `scripts/run.sh --probe=<dir>` draws the window off screen, signs in, writes `window.png` and `window.json`
  (what the page says of the window) into `<dir>` and ends: how the window is checked without anyone's desktop.
- `packages/linux/scripts/install.sh --with-window` copies it into the runtime and adds the menu entry and login item.
- `npm test`: the parts that need no Electron (`lib/`), with `node --test`; no dependencies to install.

Keys on the Terminals page are a Linux terminal's (docs/linux-app-v0.md §7.1): Ctrl+Shift+T new terminal, Ctrl+Shift+W
close, Ctrl+Shift+L list, Ctrl+Shift+F search, Ctrl+Shift+D / Ctrl+Shift+B split right / down, Ctrl+Shift+Z the pane
alone, Ctrl+Alt+arrows the next pane, Alt+1–9 a terminal, Ctrl+Shift+S the sealed reply, Ctrl+Shift+↩ / Ctrl+Shift+⌫
allow / deny, Ctrl+Shift+C / Ctrl+Shift+V copy / paste, Ctrl+click a link.
