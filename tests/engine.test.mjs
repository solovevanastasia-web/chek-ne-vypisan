import test from 'node:test';
import assert from 'node:assert/strict';
import { CRITERIA, validatePitch, validateQuestion, validateReport, makeReport, callModel, PublicError } from '../server/engine.mjs';
const s = { pitch: 'Клиенты — пекарни. 18 покупок. Берём комиссию 15%.', days: 2, answers: [] };
const question = { valid:true, reason:'', reaction:'Проверим экономику.', quote:'Берём комиссию 15%.', question:'Сколько тебе остаётся с одной покупки после всех затрат?', target:'finance' };
const report = () => ({verdict:'Пока гипотеза.',strength:'Есть первые покупки.',criteria:CRITERIA.map(([id])=>({id,score:5,status:'self_reported',reason:'Заявлены покупки, нужны подтверждения.',quote:'18 покупок.'})),advice:[1,2,3].map(i=>({action:'Посчитай затраты '+i,why:'Нет расчёта.',time:'Сегодня, час',artifact:'Таблица.'}))});
test('weights sum to 100, ten unique criteria',()=>{assert.equal(CRITERIA.reduce((v,c)=>v+c[2],0),100);assert.equal(new Set(CRITERIA.map(c=>c[0])).size,10);});
test('reject empty, noise, short and excessive pitch',()=>{for(const p of ['',null,'😀'.repeat(50),'проект','а'.repeat(8001)])assert.throws(()=>validatePitch(p),PublicError);assert.equal(validatePitch(s.pitch),s.pitch);});
test('one exact question, no duplicate or second question',()=>{assert.equal(validateQuestion(question,s).quote,question.quote);assert.throws(()=>validateQuestion({...question,question:'Кто платит? Сколько?'},s));assert.throws(()=>validateQuestion({...question,target:'fake'},s));assert.throws(()=>validateQuestion(question,{...s,answers:[{question,answer:'не знаю'}]}));});
test('invented evidence is removed',()=>{assert.equal(validateQuestion({...question,quote:'100 клиентов'},s).quote,'');const r=report();r.criteria[0].quote='Неверная цитата';const out=validateReport(r,s);assert.equal(out.criteria[0].status,'missing');assert.equal(out.criteria[0].score,null);assert.equal(out.coverage,9);});
test('score is calculated in code; missing data has zero contribution',()=>{const r=report();const out=validateReport({...r,total:100},s);assert.equal(out.total,50);r.criteria[0].status='missing';r.criteria[0].score=null;assert.equal(validateReport(r,s).total,43);});
test('requires ten unique criteria, exact three actions, scores in range',()=>{let r=report();r.criteria.pop();assert.throws(()=>validateReport(r,s));r=report();r.criteria[1].id=r.criteria[0].id;assert.throws(()=>validateReport(r,s));r=report();r.advice.push(r.advice[0]);assert.throws(()=>validateReport(r,s));r=report();r.criteria[0].score=11;assert.throws(()=>validateReport(r,s));});
test('cannot score before five answers',async()=>{await assert.rejects(makeReport(s),e=>e.status===409);});
test('invalid pitch asks for context before round, non-answer cannot abort later round',()=>{assert.equal(validateQuestion({valid:false,reason:'Добавь описание'},s).valid,false);assert.throws(()=>validateQuestion({valid:false,reason:'Нет'},{...s,answers:[{question,answer:'не знаю'}]}));});
test('API key remains only in request authorization; failures use safe messages',async()=>{
 process.env.GROQ_API_KEY='test-only-secret';process.env.LLM_API_KEY='test-only-secret';
 await assert.rejects(callModel('test',{},s,{fetchImpl:async(url,opts)=>{assert.equal(opts.headers.Authorization,'Bearer test-only-secret');assert.ok(!opts.body.includes('test-only-secret'));return {ok:false,status:429};}}),e=>e.status===429&&!e.message.includes('test-only-secret'));
});
