import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import init from './vendor/mesh_loader.mjs';
import signature from './vendor/auth-init.mjs';

const origin='https://www.meshy.ai';
async function get(url,json=false){
  const u=new URL(url);
  if(u.protocol!=='https:'||!(u.hostname==='meshy.ai'||u.hostname.endsWith('.meshy.ai'))) throw Error('Unexpected asset host');
  const r=await fetch(u,{signal:AbortSignal.timeout(120000)});
  if(!r.ok) throw Error(`Download failed (HTTP ${r.status})`);
  if(json){const j=await r.json();if(j.code!=='OK'||!j.result)throw Error('Public metadata is unavailable');return j.result;}
  return new Uint8Array(await r.arrayBuffer());
}
export async function convert(input){
  const u=new URL(input.trim());
  const match=u.pathname.match(/^\/posts\/([a-f0-9-]{36})\/?$/i);
  if(u.protocol!=='https:'||!['meshy.ai','www.meshy.ai'].includes(u.hostname)||!match)throw Error('Enter a Meshy post URL: https://www.meshy.ai/posts/…');
  const postId=match[1];
  const post=await get(`${origin}/meshyd-api/web/public/community/posts/${postId}`,true);
  const items=post.items?.filter(x=>x.kind==='model')||[];
  const item=items.find(x=>x.id===post.coverItem?.id)||items[0];
  if(!item?.refId)throw Error('This post has no public model');
  const task=await get(`${origin}/meshyd-api/web/public/v2/tasks/${item.refId}`,true);
  const phase=task.result?.[task.phase];
  const asset=phase?.modelUrl;
  if(!asset)throw Error(`No model URL for phase ${task.phase}. This post type is not supported yet.`);
  const inputBytes=await get(asset);
  let output=inputBytes;
  if(Buffer.from(inputBytes.subarray(0,8)).toString()==='MESHY.AI'){
    const m=await init();const now=Date.now();
    if(!m.authorize('localhost',now,signature('localhost',now)))throw Error('Decoder initialization failed. Meshy may have changed its loader.');
    const result=m.processMeshyFile(inputBytes);
    if(!result.success||!result.data)throw Error(result.error||'Decoder returned no data');
    output=new Uint8Array(result.data);
  }
  const b=Buffer.from(output);
  if(b.length<20||b.toString('ascii',0,4)!=='glTF'||b.readUInt32LE(4)!==2||b.readUInt32LE(8)!==b.length)throw Error('Output is not a valid GLB 2 container');
  const jsonLength=b.readUInt32LE(12);
  if(b.readUInt32LE(16)!==0x4e4f534a||20+jsonLength>b.length)throw Error('Invalid GLB JSON chunk');
  const gltf=JSON.parse(b.toString('utf8',20,20+jsonLength));
  const title=post.title||item.objectPrompt||'Meshy model';
  return {bytes:b,filename:`meshy-${postId}.glb`,metadata:{postId,title,taskId:task.id,license:task.license,bytes:b.length,meshes:gltf.meshes?.length||0,images:gltf.images?.length||0,extensionsRequired:gltf.extensionsRequired||[],modelItems:items.length}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await convert(process.argv[2]||'');const out=process.argv[3]||result.filename;await fs.writeFile(out,result.bytes);console.log(JSON.stringify({...result.metadata,file:out},null,2));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
