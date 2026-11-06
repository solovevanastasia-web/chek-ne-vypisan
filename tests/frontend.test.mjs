import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function clientContext(crypto) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id,{innerHTML:'',textContent:'',value:'',classList:{add(){},remove(){}},addEventListener(){},scrollIntoView(){},focus(){}});
    return elements.get(id);
  };
  const context=vm.createContext({crypto,console,setTimeout(){},window:{addEventListener(){}},document:{querySelector:element},navigator:{},location:{protocol:'http:',hostname:'example.test'},sessionStorage:{getItem(){return null},setItem(){}},fetch:async()=>({ok:true,json:async()=>({session:null})}),AbortSignal});
  vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),context);
  return context;
}
test('HTTP preview without crypto.randomUUID still has usable submission IDs',()=>{
  const context=clientContext({});
  const one=vm.runInContext('newRequestId()',context),two=vm.runInContext('newRequestId()',context);
  assert.equal(typeof one,'string');assert.notEqual(one,two);assert.ok(one.length>10);
});
test('HTTPS uses native UUID and dynamic text is HTML-escaped',()=>{
  const context=clientContext({randomUUID:()=> 'native-uuid'});
  assert.equal(vm.runInContext('newRequestId()',context),'native-uuid');
  assert.equal(vm.runInContext(`h('<img src=x onerror="alert(1)">&')`,context),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;');
});
