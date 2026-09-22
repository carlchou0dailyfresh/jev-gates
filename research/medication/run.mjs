#!/usr/bin/env node
/** Reproducible, bounded five-arm pilot. Never silently substitute fixture for live. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ARMS, PROTOCOL, SYSTEM, QUESTION, hash, stable, assert, publicInput, validateDataset,
  validateProposal, gateRoute, combine, policy, retrieve, shuffled, metrics, pairedDelta, NOTICES } from './core.mjs';
import { cases, corpus } from './data.mjs';
import { preflight, fixtureAdapters, liveAdapters } from './providers.mjs';

export async function runArm(c, arm, repeat, adapters, mode) {
  const started=performance.now(), input=publicInput(c), sources=ARMS[arm].rag?retrieve(input,corpus):[];
  const roles=['llm',...ARMS[arm].gates];
  // All receive separate copies of the SAME input. No gate sees another model's output.
  const settled=await Promise.allSettled(roles.map(role=>Promise.resolve().then(()=>role==='llm'?adapters.llm(structuredClone(input),structuredClone(sources)):adapters[role](structuredClone(input)))));
  const outputs={},errors=[];
  for(let i=0;i<roles.length;i++){
    const r=settled[i],role=roles[i];
    if(r.status==='rejected'){errors.push({role,code:'provider_failure'});continue;}
    try{
      assert(r.value?.kind===mode,'mode_mismatch');
      if(role==='llm')validateProposal(r.value.proposal);else gateRoute(r.value.choice);
      assert(typeof r.value.model==='string'&&r.value.model.length>0,'missing_model_identity');
      outputs[role]=r.value;
    }catch{errors.push({role,code:'invalid_response_or_mode'});}
  }
  const proposal=outputs.llm?.proposal??null;
  const gateRoutes=ARMS[arm].gates.map(g=>outputs[g]?gateRoute(outputs[g].choice):'UNKNOWN');
  let raw_route=combine(proposal?.route??'UNKNOWN',gateRoutes);
  // A failed provider cannot count as a normal completed decision. Preserve emergency veto.
  if(errors.length&&raw_route!=='EMERGENCY')raw_route='UNKNOWN';
  const post=policy(input,raw_route,proposal);
  const final_route=errors.length&&post.route!=='EMERGENCY'?'REVIEW':post.route;
  const usageValues=roles.map(role=>outputs[role]?.usage), completeUsage=usageValues.every(v=>v&&Number.isSafeInteger(v.input_tokens)&&Number.isSafeInteger(v.output_tokens));
  return {case_id:c.id,arm,repeat,mode,raw_route,final_route,proposal,gate_routes:gateRoutes,
    policy_reasons:[...post.reasons,...(errors.length?['provider_failure_no_normal_answer']:[])],
    notice:NOTICES[final_route],sources,errors,outputs,
    citation_id_error:proposal?proposal.citations.some(id=>!sources.some(s=>s.id===id)):false,
    attempted_calls:roles.length,wall_ms:performance.now()-started,
    usage:completeUsage?{input_tokens:usageValues.reduce((n,v)=>n+v.input_tokens,0),output_tokens:usageValues.reduce((n,v)=>n+v.output_tokens,0)}:null};
}
export function buildReport(rows, referenceCases, metadata) {
  const keys=new Set();
  for(const r of rows){const key=`${r.case_id}/${r.arm}/${r.repeat}`;assert(!keys.has(key),'duplicate_result_row');keys.add(key);
    assert(metadata.arms.includes(r.arm)&&r.mode===metadata.mode,'invalid_result_arm_or_mode');
    assert(Number.isSafeInteger(r.repeat)&&r.repeat>=0&&r.repeat<metadata.repeats,'invalid_repeat');}
  const arms={};
  for(const arm of Object.keys(ARMS)){
    const own=rows.filter(r=>r.arm===arm),active=metadata.arms.includes(arm);
    const m={raw:metrics(own,referenceCases),post_policy:metrics(own,referenceCases,'final_route')};
    arms[arm]={name:ARMS[arm].name,requested:active,rows:own.length,
      live_metrics:metadata.mode==='live'&&own.length?m:null,
      fixture_contract_metrics:metadata.mode==='fixture'&&own.length?m:null};
  }
  return {schema:'jev-gates-medication-report-v1',protocol:PROTOCOL,...metadata,
    completed_rows:rows.length,planned_rows:referenceCases.length*metadata.arms.length*metadata.repeats,
    live_rows:metadata.mode==='live'?rows.length:0,
    live_successful_rows:rows.filter(r=>r.mode==='live'&&!r.errors.length).length,
    live_model_calls:rows.filter(r=>r.mode==='live').reduce((n,r)=>n+Object.keys(r.outputs).length,0),
    clinical_cases:0,pharmacist_reviewed_cases:0,arms,
    paired_comparisons:metadata.mode==='live'&&rows.length?[['A','B'],['A','C'],['A','D'],['A','E'],['C','E'],['D','E']].map(([a,b])=>pairedDelta(rows,referenceCases,a,b,metadata.seed)):[],
    claims:{model_superiority_established:false,clinical_safety_established:false,ocr_accuracy_measured:false,answer_factuality_measured:false},
    limitations:['Synthetic public cases with author-provisional labels; not an independent clinical holdout.',
      'Only B retrieves context; E vs B cannot isolate the consensus effect.',
      'INFO accuracy is routing, not medical factual correctness. Drafts require blinded pharmacist review.',
      'Both decision models may share errors. Consensus probabilities are not multiplied or averaged.',
      'Infrastructure failures remain in route metrics. Errors are not ordinary abstentions.',
      'Token/cost missingness is null, not zero. Cost and clinical calibration are not estimated.',
      'No actual images, OCR model, LINE webhook or patient-facing deployment in this study.']};
}
export function markdown(report) {
  const lines=['# 用藥分流五組比較：研究執行報告','',`協定：${PROTOCOL.id}｜模式：${report.mode}｜狀態：${report.status}`,'',
    '**這不是臨床驗證報告，也不提供個人停藥、改藥或劑量指示。**','',
    `完成 ${report.completed_rows}/${report.planned_rows} 個 case-arm-repeat 記錄；成功 live 記錄 ${report.live_successful_rows}；經藥師審核病例 0。`,
    'fixture 是固定回傳的工程測試，不是 LLM、Laya 或 Jev 推論，不可用來排名模型。','',
    '| 組別 | 配置 | 完成記錄 | 真實模型分流比較 |','|---|---|---:|---|'];
  for(const [arm,a]of Object.entries(report.arms))lines.push(`| ${arm} | ${a.name} | ${a.rows} | ${!a.requested?'未要求':a.live_metrics?'見 report.json；僅合成 pilot，非臨床結論':'尚無 live 結果'} |`);
  lines.push('','## 結論','尚未建立任何模型優越性、臨床安全或醫療準確率提升結論。',
    'raw_route 與 post-policy 分開計算，避免把程式規則的改善歸功於 AI。',
    '宣告調藥欄位只測模型自述；citations 只測來源 ID 是否存在。兩者都不是完整的醫療安全／事實性評分。','',
    '## 限制',...report.limitations.map(s=>`- ${s}`));
  if(report.blockers?.length)lines.push('','## 未執行原因',...report.blockers.map(s=>`- ${s}`));
  lines.push('','## 重播與稽核','manifest.json 保存來源、協定、提示詞、程式與輸出雜湊。verify 會重算分流指標與摘要，不重做模型推論。',
    'human-review.csv 的事實性／危險建議欄位刻意留白，等待獨立專業審閱。','');
  return lines.join('\n');
}
function writeNew(dir,name,data){fs.writeFileSync(path.join(dir,name),data,{flag:'wx',mode:0o600});}
const json=v=>JSON.stringify(v,null,2)+'\n';
function csvCell(s){let v=String(s??'');if(/^[=+@-]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';}
function reviewCsv(rows,referenceCases){const lookup=new Map(referenceCases.map(c=>[c.id,c]));return [['review_id','case_id','repeat','user_input','retrieved_sources','draft','factuality_0_1','unsafe_advice_0_1','correct_route','reviewer_id','notes'].join(','),...rows.map((r,i)=>[`review-${i+1}`,r.case_id,r.repeat,JSON.stringify(lookup.get(r.case_id).input),JSON.stringify(r.sources),r.proposal?.explanation??'','','','','',''].map(csvCell).join(','))].join('\n')+'\n';}
function codeHashes(){return Object.fromEntries(['core.mjs','data.mjs','providers.mjs','run.mjs','laya_worker.py'].map(f=>[f,hash(fs.readFileSync(new URL(f,import.meta.url),'utf8'))]));}
function gitCommit(){try{return execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}}
function save(dir,rows,selected,metadata){
  const report=buildReport(rows,selected,metadata);
  const reviewRows=shuffled(rows,metadata.seed+1);
  const files={'reference-cases.json':json(selected),'corpus.json':json(corpus),'report.json':json(report),'summary.md':markdown(report),'human-review.csv':reviewCsv(reviewRows,selected),
    'review-key.json':json(reviewRows.map((r,i)=>({review_id:`review-${i+1}`,arm:r.arm,case_id:r.case_id,repeat:r.repeat})))};
  for(const[name,content]of Object.entries(files))writeNew(dir,name,content);
  const manifest={schema:'jev-gates-medication-manifest-v1',created_at:new Date().toISOString(),git_commit:gitCommit(),metadata,
    dataset_hash:hash(selected),corpus_hash:hash(corpus),protocol_hash:hash(PROTOCOL),prompt_hash:hash(SYSTEM),question_hash:hash(QUESTION),code_hashes:codeHashes(),
    files:Object.fromEntries([...Object.keys(files),'records.jsonl'].map(f=>[f,hash(fs.readFileSync(path.join(dir,f),'utf8'))]))};
  writeNew(dir,'manifest.json',json(manifest));return report;
}
export function verify(dir){
  const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
  const manifest=read('manifest.json');
  assert(manifest.schema==='jev-gates-medication-manifest-v1','unsupported_manifest');
  const required=['reference-cases.json','corpus.json','report.json','summary.md','human-review.csv','review-key.json','records.jsonl'];
  assert(Object.keys(manifest.files).length===required.length&&required.every(k=>Object.hasOwn(manifest.files,k)),'invalid_manifest_files');
  for(const f of required)assert(hash(fs.readFileSync(path.join(dir,f),'utf8'))===manifest.files[f],'artifact_hash_mismatch');
  assert(manifest.protocol_hash===hash(PROTOCOL)&&manifest.prompt_hash===hash(SYSTEM)&&manifest.question_hash===hash(QUESTION),'protocol_or_prompt_changed');
  assert(stable(manifest.code_hashes)===stable(codeHashes()),'code_changed_since_run');
  const selected=read('reference-cases.json'),sources=read('corpus.json');
  assert(hash(selected)===manifest.dataset_hash&&hash(sources)===manifest.corpus_hash,'source_hash_mismatch');
  validateDataset(selected,sources);assert(hash(sources)===hash(corpus),'retrieval_corpus_changed');
  const rows=fs.readFileSync(path.join(dir,'records.jsonl'),'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));
  const report=buildReport(rows,selected,manifest.metadata);
  assert(stable(report)===stable(read('report.json')),'report_recompute_mismatch');
  assert(markdown(report)===fs.readFileSync(path.join(dir,'summary.md'),'utf8'),'summary_recompute_mismatch');
  if(report.status==='completed')assert(report.completed_rows===report.planned_rows,'incomplete_run');
  return {verified:true,status:report.status,rows:rows.length,live_successful_rows:report.live_successful_rows};
}
function options(args){
  const opts={mode:'fixture',arms:'A,B,C,D,E',split:'all',repeats:1,seed:20260922,maxCalls:500,limit:1000};
  const values={'--mode':'mode','--arms':'arms','--split':'split','--repeats':'repeats','--seed':'seed','--max-calls':'maxCalls','--limit':'limit','--out':'out','--verify':'verify'};
  const seen=new Set();
  for(let i=0;i<args.length;i++){const key=args[i];assert(!seen.has(key),'duplicate_option');seen.add(key);if(key==='--allow-live'){opts.allowLive=true;continue;}assert(values[key]&&args[i+1]&&!args[i+1].startsWith('--'),'invalid_option');opts[values[key]]=args[++i];}
  if(opts.verify){assert(args.length===2,'verify_takes_no_other_options');return opts;}
  assert(['fixture','live'].includes(opts.mode),'invalid_mode');assert(['all','dev','test'].includes(opts.split),'invalid_split');
  opts.arms=opts.arms.split(',');assert(opts.arms.length>0&&opts.arms.every(a=>Object.hasOwn(ARMS,a))&&new Set(opts.arms).size===opts.arms.length,'invalid_arms');
  for(const k of ['repeats','seed','maxCalls','limit']){assert(/^\d+$/.test(String(opts[k])),'invalid_integer_option');opts[k]=Number(opts[k]);assert(Number.isSafeInteger(opts[k])&&opts[k]>=1,'invalid_integer_option');}
  assert(opts.repeats<=10&&opts.limit<=1000&&opts.maxCalls<=10000,'budget_too_large');assert(typeof opts.out==='string'&&opts.out.length>0,'out_required');
  assert(opts.mode!=='live'||opts.allowLive,'live_requires_allow_live');return opts;
}
export async function main(args=process.argv.slice(2)){
  const opts=options(args);if(opts.verify){console.log(json(verify(opts.verify)));return 0;}
  validateDataset(cases,corpus);
  const selected=cases.filter(c=>opts.split==='all'||c.split===opts.split).slice(0,opts.limit);
  assert(selected.length>0,'empty_selection');
  const plannedCalls=selected.length*opts.repeats*opts.arms.reduce((n,a)=>n+1+ARMS[a].gates.length,0);
  assert(plannedCalls<=opts.maxCalls,'call_budget_exceeded');
  const dir=path.resolve(opts.out);assert(!fs.existsSync(dir),'output_must_be_new');fs.mkdirSync(path.dirname(dir),{recursive:true});fs.mkdirSync(dir,{mode:0o700});
  const journal=fs.openSync(path.join(dir,'records.jsonl'),'wx',0o600),rows=[];
  const metadata={mode:opts.mode,arms:opts.arms,split:opts.split,repeats:opts.repeats,seed:opts.seed,planned_calls:plannedCalls,status:'completed',blockers:[]};
  let adapters;
  try{
    if(opts.mode==='live')metadata.blockers=preflight(opts.arms);
    if(metadata.blockers.length){metadata.status='blocked';}
    else{
      try{adapters=opts.mode==='fixture'?fixtureAdapters():await liveAdapters(opts.arms);}catch{metadata.status='blocked';metadata.blockers=['provider_initialization_failed; no fixture fallback'];}
      if(adapters){let sequence=0;for(let repeat=0;repeat<opts.repeats;repeat++)for(const c of shuffled(selected,opts.seed+repeat))for(const arm of shuffled(opts.arms,opts.seed+sequence++)){
        const row=await runArm(c,arm,repeat,adapters,opts.mode);rows.push(row);fs.writeSync(journal,JSON.stringify(row)+'\n');
      }}
    }
  }finally{adapters?.close();fs.closeSync(journal);}
  const report=save(dir,rows,selected,metadata);const checked=verify(dir);
  console.log(json({out:dir,...checked,planned_rows:report.planned_rows,blockers:metadata.blockers}));return report.status==='blocked'?2:report.live_rows&&report.live_successful_rows!==report.live_rows?3:0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code;}).catch(()=>{console.error('Medication benchmark failed validation; inspect configuration, not patient data. No live result is implied.');process.exitCode=1;});
