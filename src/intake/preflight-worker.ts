import { inspectInput, type IntakeInput } from './intake-inspection.js';
import { reject, type IntakeResult } from './preflight.js';

process.once('message', async (input: IntakeInput) => {
  let result: IntakeResult;
  try { result = await inspectInput(input); }
  catch { result = reject('worker-failed'); }
  process.send?.(result);
});
