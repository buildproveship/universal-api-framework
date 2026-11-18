import { inspectInput, type IntakeInput } from './intake-inspection.js';
import { reject, type IntakeResult } from './preflight.js';

async function handle(input: IntakeInput): Promise<void> {
  let result: IntakeResult;
  try {
    result = await inspectInput(input);
  } catch {
    result = reject('worker-failed');
  }
  process.send?.(result);
}

process.once('message', (input: IntakeInput) => {
  void handle(input);
});
