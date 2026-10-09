import { expect,test } from '@playwright/test';
import { spawn,type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { GraphNode,ProjectRecord } from '../src/api/contracts';
let worker:ChildProcess;let origin:string;
test.beforeAll(async()=>{
  worker=spawn('node',[fileURLToPath(new URL('../../../../cloud/test_support/p2_server.js',import.meta.url))],{stdio:['ignore','pipe','pipe']});
  origin=await new Promise<string>((resolve,reject)=>{
    let output='';const timeout=setTimeout(()=>reject(new Error('Cloud test Worker did not start')),10000);
    worker.once('exit',(code)=>{clearTimeout(timeout);reject(new Error(`Cloud Worker exited ${code}`));});
    worker.stdout!.on('data',(chunk:Buffer)=>{output+=chunk.toString();if(output.includes('\n')){clearTimeout(timeout);resolve((JSON.parse(output.split('\n')[0]!) as {baseUrl:string}).baseUrl);}});
    worker.stderr!.on('data',(chunk:Buffer)=>process.stderr.write(chunk));
  });
});
test.afterAll(()=>{worker?.kill();});
test('signs in, publishes, discovers, follows and inserts a fixed Cloud template',async({page})=>{
  const created=await page.request.post('/api/projects',{data:{name:'P2 Cloud Library'}});expect(created.ok()).toBe(true);
  const project=await created.json() as ProjectRecord;
  const name=`Cloud-Tick-${project.projectId}`;
  let assetId:string|undefined;
  try {
    const hostResponse=await page.request.post('/api/catalog/nodes',{data:{kind:'service',nodeId:'cloud_engine',serviceClass:'f8.pyengine'}});
    const host=await hostResponse.json() as GraphNode;
    const tickResponse=await page.request.post('/api/catalog/nodes',{data:{kind:'operator',nodeId:'cloud_tick',serviceId:'cloud_engine',serviceClass:'f8.pyengine',operatorClass:'f8.tick'}});
    expect(tickResponse.ok()).toBe(true);const tick=await tickResponse.json() as GraphNode;
    const patch=await page.request.post(`/api/projects/${project.projectId}/patch`,{data:{requestId:'seed-cloud',expectedGraphRevision:0,expectedLayoutRevision:0,
      operations:[{op:'createNode',node:host},{op:'createNode',node:tick}]}});expect(patch.ok()).toBe(true);
    const current=await (await page.request.get(`/api/projects/${project.projectId}`)).json() as ProjectRecord;
    const saved=await page.request.post(`/api/projects/${project.projectId}/components`,{data:{name,description:'# Shared Tick\n\nReusable timing configuration.',tags:['timing'],nodeIds:['cloud_tick'],expectedGraphRevision:current.document.graphRevision,expectedLayoutRevision:current.document.layoutRevision}});
    expect(saved.ok()).toBe(true);assetId=(await saved.json() as {assetId:string}).assetId;
    await page.addInitScript((id)=>localStorage.setItem('f8studio.selectedProjectId',id),project.projectId);
    await page.goto('/?view=assets');
    await page.locator('.cloud-account summary').click();
    await page.getByLabel('Cloud URL',{exact:true}).fill(origin);
    await page.getByRole('button',{name:'Save connection',exact:true}).click();
    await page.getByRole('button',{name:'Sign in to Cloud',exact:true}).click();
    await expect(page).toHaveURL(new RegExp('/v1/auth/desktop/authorize'));
    await page.locator('input[name="email"]').fill('p2@example.com');
    await page.locator('input[name="password"]').fill('p2-only-password');
    await page.locator('button[type="submit"]').first().click();
    await expect(page).toHaveURL(/view=assets/);
    const status=await (await page.request.get('/api/cloud/status')).json() as {user:{name:string}|null};expect(status.user).not.toBeNull();
    await page.locator('.asset-browser .asset-list button').filter({hasText:name}).click();
    await page.locator('.cloud-publish summary').filter({hasText:'Publish template'}).click();
    const publicationPath=`**/api/assets/${assetId}/cloud:publish`;
    await page.route(publicationPath,async(route)=>{
      const accepted=await route.fetch();expect(accepted.ok()).toBe(true);
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'test_response_lost',message:'Publication response lost'})});
    },{times:1});
    await page.getByRole('button',{name:'Publish',exact:true}).click();
    await expect(page.getByText('Publication response lost',{exact:true})).toBeVisible();
    await page.reload();
    await page.locator('.asset-browser .asset-list button').filter({hasText:name}).click();
    await page.locator('.cloud-publish summary').filter({hasText:'Publish template'}).click();
    await page.getByRole('button',{name:'Retry publication',exact:true}).click();
    await expect(page.getByText('Published v1',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Publish update',exact:true}).click();
    await expect(page.getByText('Content unchanged · v1',{exact:true})).toBeVisible();
    await page.getByLabel('Search online Library',{exact:true}).fill(name);
    const online=page.getByRole('region',{name:'Online Library',exact:true});
    await online.getByRole('button').filter({hasText:name}).click();
    await expect(online.getByRole('heading',{name:'Shared Tick',exact:true})).toBeVisible();
    await online.getByRole('button',{name:'Like · 0',exact:true}).click();
    await expect(online.getByRole('button',{name:'Unlike · 1',exact:true})).toBeVisible();
    await online.getByRole('button',{name:'Follow updates',exact:true}).click();
    await expect(online.getByRole('button',{name:'Unfollow asset',exact:true})).toBeVisible();
    await page.screenshot({path:'/tmp/f8-p2-cloud-library.png',fullPage:true});
    await page.getByRole('button',{name:'Graph',exact:true}).click();
    await page.getByRole('button',{name:'Quick node search',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Quick node search',exact:true});
    await dialog.getByLabel('Library source',{exact:true}).selectOption('cloud');
    await dialog.getByRole('textbox',{name:'Quick node search',exact:true}).fill(name);
    await dialog.getByRole('button',{name:`Details for ${name}`,exact:true}).click();
    await expect(dialog.getByLabel('Graph preview',{exact:true})).toBeVisible();
    await dialog.getByRole('button',{name:'Add node',exact:true}).click();
    await expect(dialog).toBeHidden();
    const after=await (await page.request.get(`/api/projects/${project.projectId}`)).json() as ProjectRecord;
    expect(after.document.nodes.filter((node)=>node.kind==='service')).toHaveLength(1);
    expect(after.document.nodes.filter((node)=>node.kind==='operator')).toHaveLength(2);
  } finally {
    await page.request.put('/api/cloud/settings',{data:{baseUrl:''}});
    if(assetId)await page.request.delete(`/api/assets/${assetId}`);
    await page.request.delete(`/api/projects/${project.projectId}`);
  }
});
