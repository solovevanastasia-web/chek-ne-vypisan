import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CRITERIA } from '../server/engine.mjs';
test('HTTP round: isolation, locks, replay, five answers, secrets and CSRF', async () => {
  let modelCalls=0, holdNext=false, markHeld, releaseHeld;
  const provider=http.createServer(async(req,res)=>{
    let b='';for await(const c of req)b+=c;
    const data=JSON.parse(b), s=JSON.parse(data.messages[1].content);modelCalls++;
    if (holdNext) { holdNext=false; await new Promise(resolve=>{releaseHeld=resolve;markHeld();}); }
    const value=s.dialogue.length===5?{verdict:'Нужны доказательства.',strength:'Есть покупки.',criteria:CRITERIA.map(([id])=>({id,score:5,status:'self_reported',reason:'Есть заявление о покупке.',quote:'18 покупок.'})),advice:[1,2,3].map(i=>({action:'Проверь гипотезу '+i,why:'Не хватает расчёта.',time:'Сегодня',artifact:'Расчёт.'}))}:{valid:true,reason:'',question:`Как ты проверишь гипотезу номер ${s.dialogue.length+1}?`,quote:'18 покупок.',reaction:'Проверим аргумент.',target:data.response_format.json_schema.schema.properties.target.enum[0]};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  process.env.NODE_ENV='test';process.env.GROQ_API_KEY='test-only';process.env.LLM_BASE_URL=`http://127.0.0.1:${provider.address().port}`;
  const {server}=await import('../server/index.mjs');
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(p,b,cookie='',origin='')=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...(origin?{Origin:origin}:{})},body:JSON.stringify(b)});
  try {
    const bad=await post('/api/start',{pitch:''});assert.equal(bad.status,400);assert.equal(modelCalls,0);
    const noSession=await fetch(base+'/api/session').then(r=>r.json());assert.equal(noSession.session,null);
    const started=await post('/api/start',{pitch:'Наш сервис продаёт выпечку. Пекарни — клиенты. За неделю 18 покупок.',days:2});assert.equal(started.status,200);
    const cookie=started.headers.get('set-cookie').split(';')[0];assert.match(started.headers.get('set-cookie'),/HttpOnly/);
    const data=await started.json();assert.equal(data.session.step,1);
    const evil=await post('/api/answer',{step:1,answer:'не знаю'},cookie,'https://attacker.invalid');assert.equal(evil.status,403);
    for(const route of ['/env/.env','/.env','/server/index.mjs','/%2e%2e/env/.env']){const r=await fetch(base+route);assert.equal(r.status,404);assert.ok(!(await r.text()).includes('test-only'));}
    const stale=await post('/api/answer',{step:3,answer:'не знаю'},cookie);assert.equal(stale.status,409);
    const answerRequest={step:1,answer:'Не знаю',requestId:'one'};
    holdNext=true;
    const held=new Promise(resolve=>{markHeld=resolve;});
    const first=post('/api/answer',answerRequest,cookie);
    await held;
    const concurrent=await post('/api/answer',answerRequest,cookie);
    releaseHeld();
    assert.equal(concurrent.status,409);
    assert.equal((await first).status,200);
    const count=modelCalls;const replay=await post('/api/answer',answerRequest,cookie);assert.equal(replay.status,200);assert.equal(modelCalls,count);
    let result;
    for(let step=2;step<=5;step++){const r=await post('/api/answer',{step,answer:'Не знаю',requestId:'step-'+step},cookie);assert.equal(r.status,200);result=await r.json();}
    assert.equal(result.session.answers.length,5);assert.equal(result.session.completed,true);assert.equal(result.session.question,null);assert.equal(result.session.report.advice.length,3);assert.equal(result.session.report.criteria.length,10);
    assert.equal((await post('/api/answer',{step:6,answer:'Ещё вопрос'},cookie)).status,409);assert.equal(modelCalls,6);
    assert.equal((await fetch(base+'/api/session').then(r=>r.json())).session,null);
    await post('/api/delete',{},cookie);assert.equal((await fetch(base+'/api/session',{headers:{Cookie:cookie}}).then(r=>r.json())).session,null);
  } finally { await new Promise(r=>server.close(r));await new Promise(r=>provider.close(r)); }
});
