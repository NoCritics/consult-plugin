// Entry of the delegate supervisor: `node delegate-run.js <task-id>`, started
// detached by launchSupervisor. The work is in lib/delegate-supervisor.js,
// which also stops the task on SIGTERM / SIGINT / SIGHUP / SIGBREAK.
import { runSupervisor, recordSupervisorCrash } from './lib/delegate-supervisor.js';
import { admitLocalTask } from './lib/delegate-local.js';

const taskId = process.argv[2];

// The worker is killed by the supervisor's exit hook when this process ends.
process.on('uncaughtException', (error) => {
  recordSupervisorCrash(taskId, error);
  process.exit(1);
});

// A local task waits here for the runner to have room (lib/delegate-local.js).
// (Tests that set CONSULT_DELEGATE_TEST_NO_CODEX get no Codex: choosePiLayer's default is findCodexForFence.)
await runSupervisor(taskId, { admit: admitLocalTask });
process.exit(0);
