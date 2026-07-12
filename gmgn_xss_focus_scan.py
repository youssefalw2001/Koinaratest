from __future__ import annotations
import html, json, re, shutil, subprocess, tempfile, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

BASE='https://gmgn.ai/'
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
RUN=f'XSSCAN{int(time.time())}'
MAX=14_000_000
SOURCES={
 'location.search':r'(?:window\.)?location\.search','location.hash':r'(?:window\.)?location\.hash',
 'location.href':r'(?:window\.)?location\.href','document.URL':r'document\.(?:URL|documentURI)',
 'document.referrer':r'document\.referrer','window.name':r'window\.name','URLSearchParams':r'URLSearchParams\s*\(',
 'router.query':r'\w+\.query\b','router.asPath':r'\w+\.asPath\b','message':r'addEventListener\s*\(\s*["\']message["\']|\.onmessage\s*=',
 'event.data':r'\b(?:event|e|t|r|n|a|o|i)\.data\b','storage':r'(?:local|session)Storage\.(?:getItem|getObject)\s*\('
}
SINKS={
 'dangerouslySetInnerHTML':r'dangerouslySetInnerHTML','innerHTML':r'\.innerHTML\s*=','outerHTML':r'\.outerHTML\s*=',
 'insertAdjacentHTML':r'insertAdjacentHTML\s*\(','document.write':r'document\.write(?:ln)?\s*\(',
 'createContextualFragment':r'createContextualFragment\s*\(','DOMParser':r'parseFromString\s*\([^)]*["\']text/html["\']',
 'srcdoc':r'\bsrcdoc\b|\bsrcDoc\b','eval':r'(^|[^\w$.])eval\s*\(','Function':r'new\s+Function\s*\(',
 'javascript:':r'javascript\s*:'
}
SAN={
 'DOMPurify':r'DOMPurify','sanitize':r'\bsanitize(?:Html)?\s*\(','escape':r'escapeHTML|htmlEscape',
 'text':r'\.textContent\s*=|createTextNode\s*\(','encode':r'encodeURI(?:Component)?'
}
FIELDS=('html','markdown','content','description','bio','message','text','name','symbol','title','url','href','src','code','invite_code','referral_code','comment','caption')
ROUTES=('/r/{p}','/referral/{p}','/referral','/share','/ai','/ai/skills/{p}','/twittercallback','/cooking/x/callback','/tglogin')


def get(url,limit=MAX):
 req=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/javascript,application/json,*/*'})
 try:
  with urllib.request.urlopen(req,timeout=35) as x:
   b=x.read(limit+1)[:limit]; return x.status,{k.lower():v for k,v in x.headers.items()},b,None
 except urllib.error.HTTPError as e:return e.code,{k.lower():v for k,v in e.headers.items()},e.read(200000),str(e)
 except Exception as e:return None,{},b'',f'{type(e).__name__}: {e}'


def scripts(text,base):
 out=set()
 for pat in (r'<script[^>]+src=["\']([^"\']+)["\']',r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']'):
  for m in re.finditer(pat,text,re.I):
   u=urllib.parse.urljoin(base,html.unescape(m.group(1))); p=urllib.parse.urlparse(u)
   if p.scheme in ('http','https') and (p.path.endswith('.js') or '.js?' in u):out.add(u)
 return sorted(out)


def manifest(text):
 m=re.search(r'["\'](/_next/static/[^"\']+/_buildManifest\.js)["\']',text)
 if not m:return None,{}
 u=urllib.parse.urljoin(BASE,m.group(1)); s,h,b,e=get(u,5_000_000)
 if s!=200:return u,{}
 t=b.decode(errors='replace'); out={}
 for x in re.finditer(r'["\'](/[^"\']*)["\']\s*:\s*\[([^\]]*)\]',t):
  js=re.findall(r'["\']([^"\']+\.js)["\']',x.group(2))
  if js:out[x.group(1)]=[urllib.parse.urljoin(u,z) for z in js]
 return u,out


def chunks(text,url):
 out=set(urllib.parse.urljoin(url,x) for x in re.findall(r'["\']([^"\']*(?:chunks|pages)/[^"\']+\.js)["\']',text))
 root=re.match(r'(https://[^/]+/_next/static/)',url); base=root.group(1) if root else urllib.parse.urljoin(url,'/_next/static/')
 for i,h in re.findall(r'(\d{2,6})\s*:\s*["\']([a-f0-9]{8,32})["\']',text):out.add(urllib.parse.urljoin(base,f'chunks/{i}-{h}.js'))
 return out


def mods(text):
 ms=list(re.finditer(r'(?:^|[,{}])([0-9]{2,8})\s*[:=]\s*(?:\([^)]*\)|\w+)\s*=>\s*\{',text))
 if not ms:ms=list(re.finditer(r'(?:^|[,{}])([0-9]{2,8})\s*:\s*function\s*\([^)]*\)\s*\{',text))
 if not ms:return [('whole',0,text)]
 out=[]
 for i,m in enumerate(ms):
  a=m.start(1);z=ms[i+1].start(1) if i+1<len(ms) else len(text)
  if 120<z-a<1_500_000:out.append((m.group(1),a,text[a:z]))
 return out


def H(patterns,text):return {n:[m.start() for m in re.finditer(p,text,re.I)][:50] for n,p in patterns.items() if re.search(p,text,re.I)}
def snip(text,pos,r=900):return re.sub(r'\s+',' ',text[max(0,pos-r):min(len(text),pos+r)])


def analyze(url,text):
 out=[]
 for mid,start,m in mods(text):
  src=H(SOURCES,m);sink=H(SINKS,m);san=H(SAN,m)
  if not sink:continue
  pm='message' in src; origin=bool(re.search(r'\.origin\b|\.source\b|allowedOrigins?|trustedOrigins?',m,re.I))
  fields=sorted(x for x in FIELDS if re.search(rf'\.{re.escape(x)}\b',m,re.I))
  raw=sorted(x for x in ('react-markdown','rehypeRaw','marked','markdown-it') if x.lower() in m.lower())
  for k,ps in sink.items():
   for p in ps[:10]:
    near=snip(m,p); ns=list(H(SOURCES,near)); nz=list(H(SAN,near)); nf=sorted(x for x in FIELDS if re.search(rf'\.{re.escape(x)}\b',near,re.I))
    score=(4 if ns else 0)+(2 if src else 0)+(2 if nf else 0)+(3 if k in ('dangerouslySetInnerHTML','innerHTML','outerHTML','srcdoc','eval','Function') else 0)+(3 if pm and not origin else 0)+(2 if raw else 0)-(3 if nz else 0)
    if score>=4:out.append({'score':score,'bundle':url,'module':mid,'offset':start+p,'sink':k,'sources':list(src),'near_sources':ns,'sanitizers':nz,'fields':nf or fields,'postmessage':pm,'origin_check':origin,'markdown':raw,'snippet':near[:2600]})
 return sorted(out,key=lambda x:x['score'],reverse=True)


def chrome(url):
 c=next((shutil.which(x) for x in ('google-chrome','google-chrome-stable','chromium','chromium-browser') if shutil.which(x)),None)
 if not c:return {'available':False}
 try:
  with tempfile.TemporaryDirectory() as d:
   p=subprocess.run([c,'--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-extensions','--no-first-run','--virtual-time-budget=6500',f'--user-data-dir={d}','--dump-dom',url],capture_output=True,text=True,timeout=24)
  dom=p.stdout[-2_000_000:]; return {'available':True,'returncode':p.returncode,'executed':f'data-xsscan="{RUN}"' in dom or f'data-xsscan={RUN}' in dom,'seen':RUN in dom,'excerpt':snip(dom,dom.find(RUN),400) if RUN in dom else ''}
 except Exception as e:return {'available':True,'error':f'{type(e).__name__}: {e}'}


def canaries():
 pay=f'<img src=x onerror="document.documentElement.dataset.xsscan=\'{RUN}\'">'
 brk=f'\"><svg onload="document.documentElement.dataset.xsscan=\'{RUN}\'"></svg>'
 tests=[]
 for r in ROUTES:
  if '{p}' in r:tests.append(('path',urllib.parse.urljoin(BASE,r.format(p=urllib.parse.quote(pay,safe='')))))
  else:
   for k in ('code','q','redirect'):tests.append((f'query:{k}',urllib.parse.urljoin(BASE,r)+'?'+urllib.parse.urlencode({k:brk})))
   tests.append(('hash',urllib.parse.urljoin(BASE,r)+'#'+urllib.parse.quote(pay,safe='')))
 out=[]
 for kind,u in tests[:34]:
  s,h,b,e=get(u,2_500_000);t=b.decode(errors='replace'); reflected=RUN in t
  dyn=chrome(u) if reflected or kind=='hash' or kind.startswith('query:') else {'skipped':True}
  out.append({'kind':kind,'url':u.replace(urllib.parse.quote(pay,safe=''),f'<{RUN}_PAYLOAD>'),'status':s,'error':e,'reflected':reflected,'raw':pay in t,'browser':dyn,'contexts':[snip(t,m.start(),260) for m in list(re.finditer(RUN,t))[:5]]})
  time.sleep(.15)
 return out


def main():
 s,h,b,e=get(BASE,3_000_000);page=b.decode(errors='replace');mu,routes=manifest(page)
 q=list(scripts(page,BASE));[q.extend(v) for v in routes.values()];seen=set();cands=[];maps=[]
 while q and len(seen)<240:
  u=q.pop(0)
  if u in seen or not u.startswith('https://gmgn.ai/'):continue
  seen.add(u);bs,bh,bb,be=get(u)
  if bs!=200 or not bb:continue
  t=bb.decode(errors='replace');q.extend(x for x in chunks(t,u) if x not in seen);cands.extend(analyze(u,t))
  if len(maps)<8 and (H(SINKS,t) or H(SOURCES,t)):
   for mapu in (u+'.map',):
    ms,mh,mb,me=get(mapu,7_000_000)
    if ms==200 and mb:
     item={'bundle':u,'url':mapu,'bytes':len(mb)}
     try:
      d=json.loads(mb.decode(errors='replace'));item['sources']=len(d.get('sources') or []);item['sourcesContent']=len(d.get('sourcesContent') or [])
     except Exception as x:item['error']=str(x)
     maps.append(item);break
  time.sleep(.15)
 cands.sort(key=lambda x:x['score'],reverse=True);ct=canaries()
 rep={'generated_at':int(time.time()),'run_id':RUN,'scope':'public GET/static analysis and harmless DOM marker only','root':{'status':s,'error':e,'csp':h.get('content-security-policy')},'manifest':{'url':mu,'routes':len(routes)},'bundles':len(seen),'source_maps':maps,'candidates':cands[:150],'canaries':ct,'summary':{'bundles':len(seen),'candidates':len(cands),'maps':len(maps),'reflections':sum(x['reflected'] for x in ct),'executions':sum(bool(x.get('browser',{}).get('executed')) for x in ct),'chrome':any(x.get('browser',{}).get('available') for x in ct)}}
 Path('gmgn_xss_focus_report.json').write_text(json.dumps(rep,indent=2,ensure_ascii=False))
 lines=['# GMGN Focused XSS Scan','',f"Run `{RUN}`",'',f"Browser executions: **{rep['summary']['executions']}**",f"Reflections: **{rep['summary']['reflections']}**",f"Static candidates: **{rep['summary']['candidates']}**",'']
 if not rep['summary']['executions']:lines+=['No working public-route XSS was confirmed by the harmless browser marker.','']
 for x in cands[:20]:lines.append(f"- score {x['score']} `{x['sink']}` module `{x['module']}` `{x['bundle']}` sources={x['near_sources'] or x['sources']} sanitizers={x['sanitizers']}")
 Path('gmgn_xss_focus_verdict.md').write_text('\n'.join(lines)+'\n')
 print(json.dumps(rep['summary'],indent=2));[print('CAND',json.dumps({k:x[k] for k in ('score','bundle','module','sink','sources','near_sources','sanitizers','fields','postmessage','origin_check','markdown')},ensure_ascii=False)) for x in cands[:25]]
 [print('CANARY',json.dumps({'kind':x['kind'],'url':x['url'],'status':x['status'],'reflected':x['reflected'],'executed':x.get('browser',{}).get('executed')},ensure_ascii=False)) for x in ct if x['reflected'] or x.get('browser',{}).get('executed')]

if __name__=='__main__':main()
