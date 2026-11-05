import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as domain from '../src/domain.js';
import * as catalogs from '../src/catalog.js';

// Complete actual app and registered handlers, with synthetic platform I/O.
// This tests print DOM preparation, not an OS print dialog or native layout.
async function app(){
 const initial=domain.createState();initial.plan={title:'Synthetic current title',lines:[{id:'line',code:'4.9001',quantity:2,points:null,note:'Removed synthetic note'}]};
 let raw=JSON.stringify(initial),prints=0;const nodes=new Map(),events={},documentEvents={},downloads=[];
 const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{value:'',textContent:'',innerHTML:'',dataset:{},classList:{toggle(){}},setAttribute(){},addEventListener(k,f){this[k]=f;},showModal(){},close(){}});return nodes.get(selector);};
 const context=vm.createContext({...domain,...catalogs,structuredClone,performance,Blob,Map,Set,crypto:globalThis.crypto,
  document:{querySelector:node,querySelectorAll:()=>[],body:{dataset:{},append(){}},addEventListener(k,f){documentEvents[k]=f;},createElement:()=>({click(){},remove(){}})},
  window:{addEventListener(k,f){(events[k]??=[]).push(f);},print(){prints++;}},
  localStorage:{getItem:()=>raw,setItem(k,v){assert.equal(k,'dentotar.workspace.v1');raw=v;}},
  setTimeout:()=>0,clearTimeout(){},confirm:()=>true,
  URL:{createObjectURL(blob){downloads.push(blob);return 'blob:synthetic';},revokeObjectURL(){}}});
 const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
 vm.runInContext(source.replace(/^import[\s\S]*?from '\.\/catalog\.js';\n/,'').replace(/boot\(\)\.catch\(error => showCatalogStart\(error\.message\)\);\s*$/,''),context);
 vm.runInContext(`hydrate();bindEvents();catalog={version:'synthetic',positions:[{code:'4.9001',title:'Synthetic service',privateMin:10,privateMax:10,socialPoints:10}],chapters:[],sections:[]};
  index=buildSearchIndex(catalog.positions);lookup=new Map(catalog.positions.map(p=>[p.code,p]));chapterLookup=new Map();sectionLookup=new Map();syncFields();renderCalculator();`,context);
 return {node,raw:()=>raw,prints:()=>prints,html:()=>node('#printout').innerHTML,
  before(){for(const f of events.beforeprint||[])f();},click(selector){node(selector).click();},
  edit(selector,value){const n=node(selector);n.value=value;n.input({target:n});},
  note(value){node('#plan-lines').input({target:{dataset:{note:'line'},value}});},
  async import(payload){const n=node('#import-file');n.files=[{size:100,text:async()=>JSON.stringify(payload)}];await n.change({target:n});},
  export:()=>JSON.parse(vm.runInContext('JSON.stringify(exportPlan(state,"synthetic"))',context))};
}

test('browser beforeprint builds the current plan before any print button was clicked',async()=>{
 const a=await app(),before=a.raw();a.before();
 assert.match(a.html(),/Synthetic current title/,'browser-menu printing must not be blank');
 assert.match(a.html(),/20\.00/);assert.match(a.html(),/synthetic/);assert.equal(a.prints(),0);assert.equal(a.raw(),before);
});

test('browser print cannot resurrect cleared notes, replaced plans or removed rows',async()=>{
 const a=await app();a.click('#print-plan');assert.equal(a.prints(),1);assert.match(a.html(),/Removed synthetic note/);
 a.edit('#plan-title','Updated synthetic title');a.note('');const before=a.raw();a.before();
 assert.match(a.html(),/Updated synthetic title/);assert.doesNotMatch(a.html(),/Removed synthetic note/);assert.equal(a.raw(),before);
 const imported=a.export();imported.plan={title:'Synthetic imported replacement',lines:[]};await a.import(imported);a.before();
 assert.match(a.html(),/Synthetic imported replacement/);assert.doesNotMatch(a.html(),/Synthetic service/);assert.match(a.html(),/0\.00/);
 imported.plan.lines=[{id:'replacement',code:'4.9001',quantity:1,points:null,note:''}];await a.import(imported);
 a.click('#clear-plan');a.before();assert.match(a.html(),/Neue Zusammenstellung/);assert.doesNotMatch(a.html(),/Synthetic imported replacement/);
 assert.equal(a.prints(),1,'beforeprint must not invoke print recursively');
});

test('browser print recomputes incomplete state instead of retaining a cached complete total',async()=>{
 const a=await app();a.click('#print-plan');a.edit('#tax-point','invalid');a.before();
 assert.match(a.html(),/UNVOLLSTÄNDIG/);assert.doesNotMatch(a.html(),/>20\.00</);assert.match(a.html(),/Zwischensumme/);
 a.edit('#tax-point','2.00');const before=a.raw();a.before();assert.match(a.html(),/40\.00/);assert.doesNotMatch(a.html(),/UNVOLLSTÄNDIG/);assert.equal(a.raw(),before);
});
