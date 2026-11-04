#!/usr/bin/env node
// Claude Code hook: forwards the event to the hub. Never blocks or fails the session.
const event = process.argv[2];
const { CLAUDE_HUB_SID: sid, CLAUDE_HUB_PORT: port, CLAUDE_HUB_TOKEN: token } = process.env;
if (!sid || !port || !event) process.exit(0);

let input = '';
let sent = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', send);
setTimeout(send, 1000);

async function send() {
  if (sent) return;
  sent = true;
  let payload = {};
  try {
    const data = JSON.parse(input);
    payload = { prompt: data.prompt, message: data.message, claudeSessionId: data.session_id, tool: data.tool_name };
  } catch { /* no payload */ }
  try {
    await fetch(`http://127.0.0.1:${port}/api/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-token': token },
      body: JSON.stringify({ sid, event, payload }),
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* hub not running */ }
  process.exit(0);
}
