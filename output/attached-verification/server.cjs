const http=require('http'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../..');
const base=require('../../scripts/local-server.cjs').createServer(root).listeners('request')[0];
const input=fs.readFileSync(path.join(__dirname,'input.json'),'utf8');
const bootstrap=`(()=>{const {plan,book}=${input};localStorage.setItem('gics-standalone-reference-data-v1',JSON.stringify({schemaVersion:1,revision:'attached-verification',name:'첨부 파일 검증',book}));localStorage.setItem('gics-standalone-drawing-v2:local-editor:tabs-v1',JSON.stringify({version:2,activeId:'tab1',nextDocumentId:2,nextDrawingNumber:0,documents:[{id:'tab1',plan,savedPlan:plan}]}));})();`;
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<title>WMS by Gics</title>','<title>첨부 파일 검증 · WMS by Gics</title><script src="/js/attached-verification.js"></script>');
http.createServer((req,res)=>{const url=req.url.split('?')[0];if(['/', '/index.html','/js/attached-verification.js'].includes(url)){res.writeHead(200,{'Content-Type':url.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(url.endsWith('.js')?bootstrap:html);}else base(req,res);}).listen(4175,'127.0.0.1',()=>console.log('Isolated attached-file verification: http://127.0.0.1:4175/'));
