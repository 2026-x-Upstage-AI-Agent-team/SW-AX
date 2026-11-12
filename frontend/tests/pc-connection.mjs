import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

let server,browser,baseURL;
const output=fileURLToPath(new URL('../../var/pc-connector-test/ui/',import.meta.url));
before(async()=>{
  await mkdir(output,{recursive:true});
  server=await preview({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),logLevel:'silent',preview:{host:'127.0.0.1',port:0}});
  baseURL='http://127.0.0.1:'+server.httpServer.address().port;
  browser=await chromium.launch({channel:'chrome',executablePath:process.env.CHROME_EXECUTABLE});
});
after(async()=>{await browser?.close();await server?.close();});
const registered={id:'fixture-device',name:'담당자 시험 PC',registered:true,online:true,hancom_ready:true};
async function fixture(t,device,width=1440){
  const context=await browser.newContext({baseURL,locale:'ko-KR',viewport:{width,height:1000},reducedMotion:'reduce'});
  t.after(()=>context.close());
  const page=await context.newPage();page.setDefaultTimeout(8000);
  let state={enabled:true,device,pending:0,download_available:true};
  const event={id:'event',name:'연결 안내 시험'};
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/pc-connections')return route.fulfill({json:state});
    if(path==='/api/pc-connections/installer')return route.fulfill({headers:{'Content-Disposition':'attachment; filename=SWAX-PC-Setup.exe','Content-Type':'application/octet-stream'},body:'fixture installer, do not execute'});
    const replies={'/api/events':[event],'/api/events/event/teams':[],
      '/api/dashboard':{event:event.id,events:[event],teams:[],batches:[],mail:[],reports:[]},
      '/api/operations/worker-status':{state:'running',managed:true,online:['prepare','studio','mail','report']}};
    return path in replies?route.fulfill({json:replies[path]}):route.fulfill({status:404,json:{}});
  });
  return {page,change:next=>{state=next;}};
}

test('정상 연결된 PC는 설치 안내를 접고 업로드에 설치 알림을 띄우지 않는다',async t=>{
  const {page}=await fixture(t,registered);
  await page.goto('/#/pc-connect');
  const connected=page.getByRole('status').filter({hasText:'PC 연결됨'});
  await connected.waitFor();
  assert.equal(await connected.locator('.pc-connection-indicator').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(34, 197, 94)');
  assert.equal(await page.getByRole('link',{name:'PC 연결 프로그램 다운로드'}).isVisible(),false);
  assert.equal(await page.evaluate(()=>localStorage.getItem('swax.pc.installed')),'1');
  await page.screenshot({path:output+'/connected-desktop.png',fullPage:true});
  await page.goto('/#/intake');
  await page.getByRole('link',{name:'PC 연결됨'}).first().waitFor();
  assert.equal(await page.locator('.pc-connection-notice').count(),0);
  assert.equal(await page.locator('dialog.mobile-menu').count(),1);
  assert.equal(await page.locator('dialog.mobile-menu').isVisible(),false);
});

test('설치한 PC의 연결이 끊기면 재설치 대신 실행·재연결을 안내하고 새로고침에도 기억한다',async t=>{
  const {page,change}=await fixture(t,registered);
  await page.goto('/#/pc-connect');
  await page.getByRole('status').filter({hasText:'PC 연결됨'}).waitFor();
  change({enabled:true,device:{...registered,online:false},pending:3,download_available:true});
  await page.reload();
  await page.getByRole('button',{name:'연결 프로그램 실행·재연결'}).waitFor();
  assert.equal(await page.getByRole('status').filter({hasText:'연결 프로그램 실행 필요'}).locator('.pc-connection-indicator').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(165, 173, 182)');
  assert.equal(await page.getByRole('link',{name:'PC 연결 프로그램 다운로드'}).isVisible(),false);
  await page.screenshot({path:output+'/offline-installed.png',fullPage:true});
  // Another service account on an already-installed browser still gets connection, not a forced installer.
  change({enabled:true,device:{},pending:0,download_available:true});
  await page.reload();
  await page.getByRole('button',{name:'연결 프로그램 실행·재연결'}).waitFor();
});

test('처음 사용하는 PC에서 파일을 다운로드해도 설치·연결 완료로 처리하지 않는다',async t=>{
  const {page}=await fixture(t,{});
  await page.goto('/#/pc-connect');
  await page.getByRole('button',{name:'이 PC 연결',exact:true}).waitFor();
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'PC 연결 프로그램 다운로드'}).click()]);
  assert.equal(download.suggestedFilename(),'SWAX-PC-Setup.exe');
  assert.equal(await page.evaluate(()=>localStorage.getItem('swax.pc.installed')),null);
  assert.equal(await page.getByRole('status').filter({hasText:'PC 연결됨'}).count(),0);
});

test('한글이 확인되지 않은 연결 PC와 좁은 화면에서도 재설치를 요구하지 않는다',async t=>{
  const {page}=await fixture(t,{...registered,hancom_ready:false},375);
  await page.goto('/#/pc-connect');
  await page.getByRole('alert').filter({hasText:'한글이 설치된 Windows PC인지'}).waitFor();
  assert.equal(await page.getByRole('status').filter({hasText:'한글 설치·실행 확인 필요'}).locator('.pc-connection-indicator').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(165, 173, 182)');
  assert.equal(await page.getByRole('link',{name:'PC 연결 프로그램 다운로드'}).isVisible(),false);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:output+'/hancom-required-mobile.png',fullPage:true});
});
