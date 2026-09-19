import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const cli=(...args)=>spawnSync(process.execPath,['dist/cli.js',...args],{cwd:root,encoding:'utf8',env:{...process.env,TYPESAFE_API_KEY:''}});
const base=['run','examples/support-triage.json','--input','examples/support-input.json'];
test('CLI validates, renders graph, runs offline and does not imply FALSE is command failure',async()=>{
  assert.equal(cli('validate','examples/support-triage.json').status,0);
  assert.match(cli('graph','examples/support-triage.json').stdout,/flowchart TD/);
  const demo=cli(...base,'--mock','examples/support-answers.json');
  assert.equal(demo.status,0,demo.stderr);
  assert.equal(JSON.parse(demo.stdout).outputs.priority_queue.truth,'TRUE');
  const dir=await mkdtemp(join(tmpdir(),'jev-cli-'));
  try {
    await writeFile(join(dir,'false.json'),JSON.stringify({version:1,name:'false',nodes:[{id:'result',kind:'constant',value:'FALSE'}],outputs:['result']}));
    const result=cli('run',join(dir,'false.json'),'--input','examples/support-input.json','--mock','examples/support-answers.json');
    assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).outputs.result.truth,'FALSE');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('CLI requires explicit provider, rejects conflicting flags and reports missing cloud key',()=>{
  for(const args of [[],['--mock','examples/support-answers.json','--provider','localjev'],['--provider','typesafe'],['--mock','examples/support-answers.json','--model','wrong'],['--provider','other'],['--mock','examples/support-answers.json','--max-calls','nan']]) {
    assert.equal(cli(...base,...args).status,2);
  }
});
test('CLI exposes UNKNOWN exit code and private non-overwriting trace',async()=>{
  const unknown=cli(...base,'--mock','examples/support-answers.json','--max-calls','0');
  assert.equal(unknown.status,3);assert.equal(JSON.parse(unknown.stdout).status,'abstained');
  const dir=await mkdtemp(join(tmpdir(),'jev-cli-'));
  try {
    const path=join(dir,'trace.json');
    const run=cli(...base,'--mock','examples/support-answers.json','--trace',path);
    assert.equal(run.status,0,run.stderr);
    const before=await readFile(path,'utf8');
    assert.equal((await stat(path)).mode & 0o777,0o600);
    assert.equal(cli(...base,'--mock','examples/support-answers.json','--trace',path).status,2);
    assert.equal(await readFile(path,'utf8'),before);
  } finally {await rm(dir,{recursive:true,force:true});}
});
