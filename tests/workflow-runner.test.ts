import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkflowScheduler, createPiWorkflowRunner, type WorkflowTask, type WorkflowPolicy } from '../src/workflow/index.js';

async function fixture(t: TestContext, reportArtifact = 'README.md') {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workflow-runner-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const repo = join(dir, 'repo'); await mkdir(repo);
  const git = promisify(execFile);
  await git('git', ['init', '-q'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), 'Original\n');
  await git('git', ['add', 'README.md'], { cwd: repo });
  await git('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Initial'], { cwd: repo });
  const executable = join(dir, 'fake-pi.mjs');
  const log = join(dir, 'requests.jsonl');
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
let level = 'high';
let buffer = '';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2)})+'\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', chunk => {
 buffer += chunk;
 let index;
 while ((index=buffer.indexOf('\\n')) >= 0) {
  const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;
  const command=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(command)+'\\n');
  const response = {type:'response',id:command.id,command:command.type,success:true};
  if(command.type==='get_state') response.data={model:{provider:'fixture',id:'small'},thinkingLevel:level,sessionId:'fixture-session'};
  if(command.type==='get_available_thinking_levels') response.data={levels:['off','low','medium','high']};
  if(command.type==='set_thinking_level') level=command.level;
  if(command.type==='prompt') {
   response.data={disposition:'started'};send(response);
   writeFileSync('README.md','Updated by fixture worker\\n');
   send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({summary:'README updated',acceptanceEvidence:[{criterion:0,artifact:${JSON.stringify(reportArtifact)},check:0}],risks:[]})}],usage:{input:2,output:3,totalTokens:5,cost:{total:0.01}},stopReason:'stop'}});
   send({type:'agent_settled'});
  } else send(response);
 }
});
`);
  await chmod(executable, 0o700);
  return { dir, repo, executable, log };
}
const task: WorkflowTask = { taskId: 'readme', goal: 'Update the README', complexity: 'simple', scope: ['README.md'], acceptanceCriteria: ['README contains updated content'], expectedArtifacts: ['README.md'], tools: ['read', 'edit', 'write'], checks: [[process.execPath, '-e', "const fs=require('node:fs'); if(!fs.readFileSync('README.md','utf8').includes('Updated by fixture worker')) process.exit(1)"]] };
const policy: WorkflowPolicy = { scope: ['README.md'], tools: ['read', 'edit', 'write'], network: true, allowChecks: true };

test('real workflow runner routes live effort, runs host checks, hashes actual artifacts and preserves user branch', async t => {
  const f = await fixture(t);
  const scheduler = new WorkflowScheduler({ runner: createPiWorkflowRunner({ workspaceRoot: f.repo, stateDir: join(f.dir, 'state'), executable: f.executable }) });
  t.after(() => scheduler.close());
  const flow = scheduler.submit({ goal: 'Update README', tasks: [task] }, policy);
  const ended = await scheduler.start(flow.workflowId);
  assert.equal(ended.status, 'succeeded', ended.tasks[0]!.error);
  const state = ended.tasks[0]!;
  assert.equal(state.model.thinkingLevel, 'low'); assert.equal(state.model.provider, 'fixture'); assert.equal(state.model.model, 'small');
  assert.equal(state.result!.checks[0]!.exitCode, 0); assert.match(state.result!.patch!, /Updated by fixture worker/);
  assert.match(state.result!.acceptanceEvidence[0]!.evidence, /sha256=/); assert.equal(state.result!.usage!.tokens, 5);
  assert.equal(await readFile(join(f.repo, 'README.md'), 'utf8'), 'Original\n');
  const requests = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.some(record => record.type === 'set_thinking_level' && record.level === 'low'), true);
  const argv: string[] = requests[0]!.args;
  for (const flag of ['--no-extensions', '--no-mcp', '--no-skills', '--no-context-files']) assert.ok(argv.includes(flag));
});

test('runner rejects model artifact claims that lack independently collected files', async t => {
  const f = await fixture(t, 'invented.txt');
  const scheduler = new WorkflowScheduler({ runner: createPiWorkflowRunner({ workspaceRoot: f.repo, stateDir: join(f.dir, 'state'), executable: f.executable }) });
  t.after(() => scheduler.close());
  const flow = scheduler.submit({ goal: 'Update README', tasks: [task] }, policy);
  const ended = await scheduler.start(flow.workflowId);
  assert.equal(ended.status, 'indeterminate'); assert.match(ended.tasks[0]!.error!, /Unverified artifact reference/);
  assert.equal(await readFile(join(f.repo, 'README.md'), 'utf8'), 'Original\n');
});

test('network-denied host execution is rejected before spawning Pi or modifying files', async t => {
  const f = await fixture(t);
  const scheduler = new WorkflowScheduler({ runner: createPiWorkflowRunner({ workspaceRoot: f.repo, stateDir: join(f.dir, 'state'), executable: f.executable }) });
  t.after(() => scheduler.close());
  const flow = scheduler.submit({ goal: 'Update README', tasks: [task] }, { ...policy, network: false });
  const ended = await scheduler.start(flow.workflowId);
  assert.equal(ended.status, 'failed'); assert.match(ended.tasks[0]!.error!, /OS sandbox/);
  await assert.rejects(readFile(f.log), /ENOENT/);
});
