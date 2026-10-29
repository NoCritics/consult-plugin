// The defaults the MCP server and the Claude Code mod share (hooks/mod/settings.ts
// reads the same defaults.json), so the band's progress bars span the limits
// the server actually enforces.

import fs from 'node:fs';

export const CONSULT_DEFAULTS = Object.freeze(
  JSON.parse(fs.readFileSync(new URL('./defaults.json', import.meta.url), 'utf8'))
);
