import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runCircuit, validateCircuit, logic, and, or, not, kofn, applyPolicy, mountCircuit, toMermaid, MockProvider } from '../dist/index.js';

const T = 'TRUE', F = 'FALSE', U = 'UNKNOWN';
const semantic = (id, extra = {}) => ({ id, kind: 'semantic', question: { type: 'noul', instructions: `Does the observation satisfy ${id}?` }, policy: { type: 'noul', falseAt: 0.2, trueAt: 0.8 }, ...extra });
const circuit = (nodes, outputs = [nodes.at(-1).id]) => ({ version: 1, name: 'test', nodes, outputs });
const mock = answers => new MockProvider(Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { type: 'noul', noul }])));

test('all binary ternary truth tables, including unknown dominance and XOR parity', () => {
  const andTable = [[T,F,U],[F,F,F],[U,F,U]], orTable = [[T,T,T],[T,F,U],[T,U,U]];
  for (const [i, a] of [T,F,U].entries()) for (const [j,b] of [T,F,U].entries()) {
    assert.equal(logic('and',[a,b]), andTable[i][j]);
    assert.equal(logic('or',[a,b]), orTable[i][j]);
    assert.equal(logic('nand',[a,b]), logic('not',[andTable[i][j]]));
    assert.equal(logic('nor',[a,b]), logic('not',[orTable[i][j]]));
    assert.equal(logic('xor',[a,b]), a === U || b === U ? U : a === b ? F : T);
  }
  assert.equal(logic('xor',[T,T,T]), T);
  assert.equal(logic('not',[U]), U);
});

test('k-of-n matches all possible completions of three-valued votes', () => {
  for (const a of [T,F,U]) for (const b of [T,F,U]) for (const c of [T,F,U]) for (const k of [1,2,3]) {
    const votes = [a,b,c];
    let completions = [[]];
    for (const v of votes) completions = completions.flatMap(xs => (v === U ? [T,F] : [v]).map(x => [...xs,x]));
    const outcomes = new Set(completions.map(xs => xs.filter(x=>x === T).length >= k ? T : F));
    assert.equal(logic('kofn',votes,k), outcomes.size === 1 ? [...outcomes][0] : U);
  }
});

test('explicit policy boundaries and choice unknown/separation', () => {
  const policy = {type:'noul',falseAt:0.2,trueAt:0.8};
  for (const [noul, truth] of [[0.2,F],[0.8,T],[0.5,U]]) assert.equal(applyPolicy({type:'noul',noul},policy).truth,truth);
  const p = {type:'choice',trueLabels:['YES'],falseLabels:['NO'],unknownLabels:['OTHER'],minProbability:0.6,minMargin:0.2};
  assert.equal(applyPolicy({type:'choice',choice:'OTHER',probabilities:{YES:0,NO:0,OTHER:1},confidence:1},p).truth,U);
  assert.equal(applyPolicy({type:'choice',choice:'YES',probabilities:{YES:0.55,NO:0.45,OTHER:0},confidence:1},p).truth,U);
  const lowConfidence = applyPolicy({type:'score',score:1.9,confidence:0.1,probabilities:{'0':0,'1':0.1,'2':0.9},legend:{'0':'low','1':'medium','2':'high'}},{type:'score',falseAt:0.5,trueAt:1.5,minConfidence:0.8});
  assert.equal(lowConfidence.truth,U);
  assert.equal(lowConfidence.reason,'insufficient_confidence');
});

test('reject invalid graph schema, cycles, references, policies and exact numeric rules', () => {
  const invalid = [
    circuit([semantic('x'), semantic('x')]),
    circuit([{id:'x',kind:'logic',op:'not',inputs:['x']}]),
    circuit([{id:'x',kind:'logic',op:'and',inputs:['absent']}]),
    circuit([semantic('x',{policy:{type:'noul',falseAt:0.8,trueAt:0.2}})]),
    circuit([semantic('x',{input:'/bad~x'})]),
    circuit([{id:'x',kind:'rule',op:'gt',path:'/x',value:'1'}]),
    circuit([{id:'x',kind:'logic',op:'not',inputs:[]}]),
    circuit([semantic('constructor')]),
    {...circuit([semantic('x')]),typo:true},
    circuit([semantic('x',{question:{type:'choice',instructions:'Choose',criteria:{YES:null,OTHER:null}},policy:{type:'choice',trueLabels:['YES'],falseLabels:[],unknownLabels:[],minProbability:0.8,minMargin:0.1}})])
  ];
  for (const value of invalid) assert.throws(() => validateCircuit(value));
  assert.throws(()=>validateCircuit(circuit([{id:'x',kind:'constant',value:NaN}])));
});

test('public logic and policy helpers cannot turn malformed inputs into TRUE', () => {
  for (const fn of [and, or, values => kofn(values,1)]) assert.throws(()=>fn(['typo','TRUE']));
  assert.throws(()=>not('typo'));
  const policy={type:'choice',trueLabels:['yes'],falseLabels:['no'],unknownLabels:['unknown'],minProbability:0.8,minMargin:0.2};
  assert.equal(applyPolicy({type:'choice',choice:'yes',probabilities:{no:1},confidence:0.1},policy).truth,U);
  assert.equal(applyPolicy({type:'score',score:Infinity,confidence:NaN,legend:{'0':'low','1':'high'},probabilities:{'0':0,'1':1}},{type:'score',falseAt:0.2,trueAt:0.8,minConfidence:0.5}).truth,U);
  assert.equal(applyPolicy({type:'noul',noul:2},{type:'noul',falseAt:0.2,trueAt:0.8}).truth,U);
  assert.equal(applyPolicy({type:'noul',noul:0.9},{type:'noul',falseAt:1,trueAt:0}).truth,U);
});

test('deterministic rules distinguish absent, null, zero and numeric strings', async () => {
  const result = await runCircuit(circuit([
    {id:'missing',kind:'rule',path:'/absent',op:'eq',value:null},
    {id:'exists',kind:'rule',path:'/empty',op:'exists'},
    {id:'zero',kind:'rule',path:'/zero',op:'eq',value:0},
    {id:'number',kind:'rule',path:'/string',op:'gt',value:1},
    {id:'escaped',kind:'rule',path:'/a~1b/~0key',op:'eq',value:true},
    {id:'inherited',kind:'rule',path:'/toString',op:'exists'},
    {id:'array',kind:'rule',path:'/arr/length',op:'exists'}
  ],['missing','exists','zero','number','escaped','inherited','array']),{empty:null,zero:0,string:'9','a/b':{'~key':true},arr:[1]});
  assert.deepEqual(Object.values(result.outputs).map(s=>s.truth),[U,T,T,U,T,F,F]);
  assert.equal(result.calls.length,0);
});

test('same observations batch; dependent semantic layers see immutable signals and source', async () => {
  const seen=[];
  const provider={ name:'spy',model:'v1',async evaluate(state, questions){
    seen.push(structuredClone({state,questions}));
    return {model:'v1',answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'noul',noul:0.95}]))};
  }};
  const result=await runCircuit(circuit([semantic('a'),semantic('b'),semantic('higher',{context:['a','b']})]),{message:'hello'}, {provider});
  assert.equal(seen.length,2);
  assert.deepEqual(Object.keys(seen[0].questions),['a','b']);
  assert.equal(seen[1].state.observation.message,'hello');
  assert.equal(seen[1].state.signals.a.truth,T);
  assert.equal(result.outputs.higher.truth,T);
  assert.ok(!JSON.stringify(result).includes('hello'));
});

test('unknown context and false conditions skip downstream calls without becoming FALSE',async()=>{
  const result=await runCircuit(circuit([semantic('a'),semantic('b',{context:['a']}),semantic('c',{when:'a'})],['b','c']), 'text', {provider:mock({a:0.5})});
  assert.equal(result.calls.length,1);
  assert.equal(result.outputs.b.reason,'context_unknown');
  assert.equal(result.outputs.c.truth,U);
  const skipped=await runCircuit(circuit([semantic('a'),semantic('b',{when:'a'})]), 'text',{provider:mock({a:0.01})});
  assert.equal(skipped.outputs.b.reason,'condition_false');
  assert.equal(skipped.outputs.b.truth,U);
});

test('missing fields do not call models; budget exhaustion and missing provider abstain',async()=>{
  const c=circuit([semantic('a',{input:'/missing'})]);
  assert.equal((await runCircuit(c,{})).outputs.a.reason,'missing_input');
  assert.equal((await runCircuit(circuit([semantic('a')]),{})).outputs.a.reason,'provider_missing');
  const limited=await runCircuit(circuit([semantic('a'),semantic('b',{context:['a']})]),'text',{provider:mock({a:1,b:1}),maxCalls:1});
  assert.equal(limited.calls.length,1);
  assert.equal(limited.outputs.b.reason,'call_budget_exhausted');
});

test('provider errors, missing answers, malformed numbers and deadlines abstain without leaking errors',async()=>{
  for (const evaluate of [
    async()=>{throw new Error('secret-token');},
    async()=>({model:'v',answers:{}}),
    async()=>({model:'v',answers:{a:{type:'noul',noul:NaN}}}),
    ()=>new Promise(()=>{})
  ]) {
    const result=await runCircuit(circuit([semantic('a')]),'secret-input',{provider:{name:'test',model:'v',evaluate},timeoutMs:10});
    assert.equal(result.outputs.a.truth,U);
    assert.equal(result.calls.length,1);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('aborted runs do not invoke provider; inputs are copied across async layers',async()=>{
  const controller=new AbortController();controller.abort();
  let called=false;
  const result=await runCircuit(circuit([semantic('a')]),{}, {signal:controller.signal,provider:{name:'test',model:'v',async evaluate(){called=true;throw new Error();}}});
  assert.equal(called,false);assert.equal(result.outputs.a.reason,'aborted');
  const input={nested:{value:1}};
  await runCircuit(circuit([semantic('a')]),input,{provider:{name:'mutator',model:'v',async evaluate(state){state.nested.value=2;return{model:'v',answers:{a:{type:'noul',noul:1}}};}}});
  assert.equal(input.nested.value,1);
});

test('16-question batches respect budget and reusable circuits namespace all edges',async()=>{
  const nodes=Array.from({length:17},(_,i)=>semantic('n'+i));
  const answers=Object.fromEntries(nodes.map(n=>[n.id,1]));
  const result=await runCircuit(circuit(nodes),'text',{provider:mock(answers)});
  assert.deepEqual(result.calls.map(c=>c.questionIds.length),[16,1]);
  const child=circuit([semantic('a'),semantic('b',{context:['a'],when:'a'}),{id:'both',kind:'logic',op:'and',inputs:['a','b']}]);
  const mounted=mountCircuit('one',child);
  assert.deepEqual(mounted.nodes[1].context,['one.a']);
  assert.equal(mounted.nodes[1].when,'one.a');
  const combined=validateCircuit(circuit([...mounted.nodes,...mountCircuit('two',child).nodes],['one.both','two.both']));
  assert.ok(toMermaid(combined).includes('when TRUE'));
  assert.equal(child.nodes[0].id,'a');
});

test('checked-in examples execute using declared fixtures',async()=>{
  for (const name of ['support','layered']) {
    const filename=name === 'support' ? 'support-triage' : 'layered-review';
    const load=async path=>JSON.parse(await readFile(new URL('../examples/'+path+'.json',import.meta.url),'utf8'));
    const result=await runCircuit(await load(filename),await load(name+'-input'),{provider:new MockProvider(await load(name+'-answers'))});
    assert.equal(result.status,'evaluated');
    assert.ok(Object.values(result.outputs).some(s=>s.truth===T));
  }
});
