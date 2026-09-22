import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { jevAdapter } from '../research/medication/providers.mjs';
import { QUESTION,consensus } from '../research/medication/core.mjs';
const built=existsSync(new URL('../dist/index.js',import.meta.url));
test('medication bridge uses the actual jev-gates TypeSafeProvider (mock transport, no model)',{skip:!built},async()=>{
 const {TypeSafeProvider,and,or}=await import('../dist/index.js');
 const original=globalThis.fetch;let wire;
 globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'https://api.typesafe.ai/v1/systemone');wire=JSON.parse(options.body);
  return new Response(JSON.stringify({model:'jev-contract-test',answers:{route:{type:'choice',choice:'EMERGENCY',probabilities:{INFO:0,CLARIFY:0,REVIEW:0,EMERGENCY:1,UNKNOWN:0},confidence:1}},usage:{input_tokens:10,output_tokens:0}}));
 };
 try{
  const out=await jevAdapter(new TypeSafeProvider({apiKey:'contract-test-not-a-real-key',model:'jev-contract-test'}))({message:'Synthetic contract input'});
  assert.deepEqual(wire.questions,QUESTION);assert.equal(out.choice.choice,'EMERGENCY');assert.equal(out.raw.model,'jev-contract-test');
  assert.equal(or(['FALSE','TRUE']),'TRUE');assert.equal(and(['TRUE','UNKNOWN']),'UNKNOWN');assert.equal(consensus(['INFO','EMERGENCY']),'EMERGENCY');
 }finally{globalThis.fetch=original;}
});
