// Session status from Claude Code hook events.
//   idle     – started, no prompt yet
//   running  – working on a prompt
//   waiting  – needs the user (permission prompt, question)
//   done     – finished its turn
//   exited   – process ended
function nextStatus(current, event) {
  if (current === 'exited') return current;
  switch (event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'running';
    case 'Notification':
      // the idle reminder after a finished turn is not a new request
      return current === 'done' || current === 'idle' ? current : 'waiting';
    case 'Stop':
      return 'done';
    case 'exit':
      return 'exited';
    default:
      return current;
  }
}

// Transitions worth a desktop notification
function shouldNotify(prev, next) {
  return prev !== next && (next === 'waiting' || next === 'done');
}

module.exports = { nextStatus, shouldNotify };
