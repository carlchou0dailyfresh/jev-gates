/** Adapters use explicit identities; no mock fallback in live mode. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARMS, QUESTION, ROUTES, SYSTEM, assert, validateChoice, validateProposal } from './core.mjs';

export function preflight(arms, env=process.env) {
  const missing=[]; const gates=new Set(arms.flatMap(a=>ARMS[a].gates));
  if(!env.LLM_MODEL)missing.push('LLM_MODEL');
  const base=env.LLM_BASE_URL??'https://api.openai.com/v1';
  try { const u=new URL(base); if(u.username||u.password||u.search||u.hash||!(u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))))missing.push('valid HTTPS or loopback LLM_BASE_URL');
    if(u.hostname!=='127.0.0.1'&&u.hostname!=='localhost'&&u.hostname!=='[::1]'&&!env.OPENAI_API_KEY)missing.push('OPENAI_API_KEY');
  } catch { missing.push('valid LLM_BASE_URL'); }
  if(gates.has('jev')){if(!env.TYPESAFE_API_KEY)missing.push('TYPESAFE_API_KEY');if(!env.JEV_MODEL)missing.push('JEV_MODEL');}
  if(gates.has('laya')&&(!env.LAYA_CHECKPOINT||!existsSync(env.LAYA_CHECKPOINT)))missing.push('LAYA_CHECKPOINT (existing local multilingual checkpoint)');
  return [...new Set(missing)];
}
async function boundedJson(response) {
  const max=1024*1024; let size=0; const chunks=[];
  assert(response.body,'empty_response');
  const reader=response.body.getReader();
  try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new Error('response_too_large');}chunks.push(value);} }
  finally {reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('invalid_response_json');}
}
function validUsage(u) { return u && Number.isSafeInteger(u.input_tokens)&&u.input_tokens>=0&&Number.isSafeInteger(u.output_tokens)&&u.output_tokens>=0?{input_tokens:u.input_tokens,output_tokens:u.output_tokens}:null; }
export function llmAdapter(env=process.env, fetchImpl=fetch) {
  const base=env.LLM_BASE_URL??'https://api.openai.com/v1', key=env.OPENAI_API_KEY;
  return async (input,sources) => {
    const request={model:env.LLM_MODEL,store:false,max_completion_tokens:1000,response_format:{type:'json_object'},messages:[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify({input,sources})}]};
    const started=performance.now();
    const response=await fetchImpl(`${base.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',...(key?{authorization:`Bearer ${key}`}:{})},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok){await response.body?.cancel();throw new Error(`llm_http_${response.status}`);}
    const raw=await boundedJson(response);
    assert(!key||!JSON.stringify(raw).includes(key),'credential_echo');
    assert(typeof raw.model==='string'&&raw.model.length>0,'missing_model_identity');
    assert(raw.choices?.[0]?.finish_reason==='stop'&&!raw.choices?.[0]?.message?.refusal,'llm_incomplete_or_refused');
    let proposal;try{proposal=JSON.parse(raw.choices[0].message.content);}catch{throw new Error('invalid_llm_json');}
    return {kind:'live',provider:'openai-compatible',requested_model:env.LLM_MODEL,model:raw.model,
      proposal:validateProposal(proposal),usage:validUsage(raw.usage?{input_tokens:raw.usage.prompt_tokens,output_tokens:raw.usage.completion_tokens}:null),
      elapsed_ms:performance.now()-started,request,raw};
  };
}
export function jevAdapter(provider) {
  return async input => {
    const started=performance.now(); let transport=null;
    const out=await provider.evaluate(input,structuredClone(QUESTION),{onTransport:v=>{transport=v;}});
    return {kind:'live',provider:'typesafe',model:out.model,choice:validateChoice(out.answers.route),
      usage:validUsage(out.usage),elapsed_ms:performance.now()-started,request:transport?.request??{state:input,questions:QUESTION},raw:transport?.response??out};
  };
}
export async function layaAdapter(checkpoint, python=process.env.PYTHON??'python3') {
  const path=fileURLToPath(new URL('./laya_worker.py',import.meta.url));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k)));
  const child=spawn(python,[path,checkpoint],{shell:false,env:{...env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},stdio:['pipe','pipe','ignore']});
  const lines=createInterface({input:child.stdout}); const pending=new Map(); let sequence=0, metadata, broken=false;
  let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const fail=()=>{if(broken)return;broken=true;readyReject(new Error('laya_worker_unavailable'));for(const p of pending.values())p.reject(new Error('laya_worker_failed'));pending.clear();};
  child.on('error',fail);child.on('exit',fail);
  lines.on('line',line=>{if(line.length>1024*1024){fail();child.kill();return;}let msg;try{msg=JSON.parse(line);}catch{fail();child.kill();return;}
    if(msg.ready){metadata=msg;readyResolve();return;}const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);msg.error?p.reject(new Error('laya_prediction_failed')):p.resolve(msg);});
  const loadTimer=setTimeout(()=>{fail();child.kill();},120000);
  try{await ready;}finally{clearTimeout(loadTimer);}
  const predict=async input=>{
    assert(!broken,'laya_worker_unavailable');const id=++sequence,started=performance.now();
    const request={id,state:input,questions:QUESTION};
    const raw=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('laya_timeout'));fail();child.kill();},30000);
      pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
      child.stdin.write(JSON.stringify(request)+'\n',error=>{if(error){const p=pending.get(id);pending.delete(id);p?.reject(new Error('laya_pipe_error'));}});});
    return {kind:'live',provider:'laya',model:metadata.model,metadata,choice:validateChoice(raw.result.answers.route),usage:validUsage(raw.result.usage),elapsed_ms:performance.now()-started,request,raw};
  };
  return {predict,close:()=>{child.stdin.end();child.kill();},metadata};
}
export function fixtureAdapters() {
  // Constant outputs deliberately DO NOT use case IDs, labels, or expected routes.
  const choice={type:'choice',choice:'INFO',probabilities:Object.fromEntries(ROUTES.map(r=>[r,r==='INFO'?.9:.025])),confidence:.8};
  const gate=async input=>({kind:'fixture',provider:'constant-contract-fixture',model:'not-a-model',choice:structuredClone(choice),usage:null,request:{state:input,questions:QUESTION},raw:{fixture:true,choice},elapsed_ms:0});
  return {llm:async(input,sources)=>({kind:'fixture',provider:'constant-contract-fixture',model:'not-a-model',proposal:{route:'INFO',change_medication:false,explanation:'Contract fixture; not a generated medical answer.',citations:[]},usage:null,request:{input,sources},raw:{fixture:true},elapsed_ms:0}),laya:gate,jev:gate,close:()=>{}};
}
export async function liveAdapters(arms,env=process.env) {
  assert(preflight(arms,env).length===0,'live_configuration_missing');
  const gates=new Set(arms.flatMap(a=>ARMS[a].gates)), a={llm:llmAdapter(env),close:()=>{}};
  if(gates.has('jev')){
    // Reuse the project's actual official TypeSafe provider. LocalJev is NOT Jev.
    const {TypeSafeProvider}=await import('../../dist/index.js');
    a.jev=jevAdapter(new TypeSafeProvider({apiKey:env.TYPESAFE_API_KEY,model:env.JEV_MODEL,timeoutMs:30000}));
  }
  if(gates.has('laya')){const worker=await layaAdapter(env.LAYA_CHECKPOINT);a.laya=worker.predict;a.close=worker.close;}
  return a;
}
