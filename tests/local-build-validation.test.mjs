import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const fixture=()=>({schemaVersion:1,version:'synthetic',sources:[{id:'synthetic',title:'Synthetic source',url:'https://example.invalid/source.pdf'}],
 chapters:[{id:'T',title:'Synthetic chapter'}],sections:[{id:'T.1',title:'Synthetic section'}],
 positions:[{code:'TEST.1',title:'Synthetic item',kind:'service',chapter:'T',section:'T.1',socialPoints:10,privateMin:8,privateMax:12,excludes:[],members:[],packages:[]}],notices:[]});
const mutations={duplicate:c=>c.positions.push(structuredClone(c.positions[0])),reversed:c=>c.positions[0].privateMin=20,
 unknownChapter:c=>c.positions[0].chapter='missing',invalidNumber:c=>c.positions[0].socialPoints='10',brokenSource:c=>c.sources[0].url='javascript:synthetic'};
async function bytes(root,prefix=''){
 const out={};for(const e of await readdir(root,{withFileTypes:true})){const key=prefix+e.name,full=path.join(root,e.name);if(e.isDirectory())Object.assign(out,await bytes(full,key+'/'));else out[key]=(await readFile(full)).toString('hex');}return out;
}
for(const [name,mutate]of Object.entries(mutations))test(`local build rejects ${name} before replacing an existing usable build`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dentotar-local-validation-'));
 try{
  for(const f of ['scripts/build.mjs','src/domain.js','src/catalog.js']){await mkdir(path.dirname(path.join(root,f)),{recursive:true});await cp(new URL('../'+f,import.meta.url),path.join(root,f));}
  await writeFile(path.join(root,'package.json'),' {"type":"module"} ');await writeFile(path.join(root,'index.html'),'<html><head></head><body>Synthetic</body></html>');
  await mkdir(path.join(root,'public/data'),{recursive:true});const catalog=path.join(root,'public/data/catalog.json');await writeFile(catalog,JSON.stringify(fixture()));
  const build=()=>spawnSync(process.execPath,['scripts/build.mjs'],{cwd:root,encoding:'utf8',timeout:10000});
  const valid=build();assert.equal(valid.status,0,valid.stdout+valid.stderr);const before=await bytes(path.join(root,'dist'));
  const invalid=fixture();mutate(invalid);const raw=JSON.stringify(invalid);await writeFile(catalog,raw);
  const result=build();assert.notEqual(result.status,0,'the app rejects this catalog; local build must reject it too');
  assert.match(result.stderr,/Katalogformat/);assert.deepEqual(await bytes(path.join(root,'dist')),before,'last usable build must remain byte-identical');
  assert.equal(await readFile(catalog,'utf8'),raw,'validation must not repair source inputs');
 }finally{await rm(root,{recursive:true,force:true});}
});
