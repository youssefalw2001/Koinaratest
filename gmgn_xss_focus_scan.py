from __future__ import annotations
import html,json,re,time,urllib.error,urllib.parse,urllib.request
from collections import defaultdict,deque
from pathlib import Path
BASE='https://gmgn.ai/'
UA='Mozilla/5.0 Chrome/124 Safari/537.36'
MAX_BUNDLES=320
SINKS={
'dangerouslySetInnerHTML':r'dangerouslySetInnerHTML','innerHTML':r'\.innerHTML\s*=','outerHTML':r'\.outerHTML\s*=',
'insertAdjacentHTML':r'insertAdjacentHTML\s*\(','srcDoc':r'\bsrcDoc\b|\.srcdoc\s*=','document.write':r'document\.write(?:ln)?\s*\(',
'contextualFragment':r'createContextualFragment\s*\(','parseHTML':r'parseFromString\s*\([^)]*["\']text/html["\']',
'eval':r'(^|[^\w$.])eval\s*\(','newFunction':r'new\s+Function\s*\(','setTimeoutString':r'setTimeout\s*\(\s*["\'`]',
'scriptElement':r'createElement\s*\(\s*["\']script["\']','scriptSrc':r'\.src\s*=\s*[^;]{0,300}',
'postMessage':r'addEventListener\s*\(\s*["\']message["\']|\.onmessage\s*=','locationAssign':r'(?:window\.)?location(?:\.href)?\s*=|location\.(?:assign|replace)\s*\('
}
SOURCES={
'url':r'location\.(?:search|hash|href)|URLSearchParams\s*\(|router\.(?:query|asPath)','message':r'\b(?:event|e|t|r|n|a|o|i)\.data\b',
'storage':r'(?:local|session)Storage\.(?:getItem|getObject)\s*\(','apiFields':r'\.(?:content|description|bio|message|text|html|markdown|url|poster|media|video|image|href|src)\b',
'props':r'\{[^}]{0,300}(?:html|content|description|url|poster|media|src)[^}]{0,300}\}\s*=\s*e'
}
SAN={'DOMPurify':r'DOMPurify|\.sanitize\s*\(','escape':r'escapeHTML|htmlEscape|encodeURI(?:Component)?','safeUrl':r'isSafeUrl','text':r'textContent\s*=|createTextNode\s*\('}

def get(u,limit=18_000_000):
 req=urllib.request.Request(u,headers={'User-Agent':UA,'Accept':'text/html,application/javascript,*/*'})
 try:
  with urllib.request.urlopen(req,timeout=35) as r:return r.status,r.read(limit+1)[:limit],None
 except urllib.error.HTTPError as e:return e.code,e.read(200000),str(e)
 except Exception as e:return None,b'',f'{type(e).__name__}: {e}'

def urls(t,base):
 out=set()
 for p in (r'<script[^>]+src=["\']([^"\']+)["\']',r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']'):
  for m in re.finditer(p,t,re.I):
   u=urllib.parse.urljoin(base,html.unescape(m.group(1)))
   if u.startswith('https://gmgn.ai/') and (urllib.parse.urlparse(u).path.endswith('.js') or '.js?' in u):out.add(u)
 return out

def manifest(t):
 m=re.search(r'["\'](/_next/static/[^"\']+/_buildManifest\.js)["\']',t)
 if not m:return None,{}
 u=urllib.parse.urljoin(BASE,m.group(1));s,b,e=get(u,7_000_000)
 if s!=200:return u,{}
 x=b.decode(errors='replace');out={}
 for q in re.finditer(r'["\'](/[^"\']*)["\']\s*:\s*\[([^\]]*)\]',x):
  js=re.findall(r'["\']([^"\']+\.js)["\']',q.group(2))
  if js:out[q.group(1)]=[urllib.parse.urljoin(u,z) for z in js]
 return u,out

def dynamic(t,u):
 out=set(urllib.parse.urljoin(u,x) for x in re.findall(r'["\']([^"\']*(?:chunks|pages)/[^"\']+\.js)["\']',t))
 root=re.match(r'(https://[^/]+/_next/static/)',u);base=root.group(1) if root else urllib.parse.urljoin(u,'/_next/static/')
 for n,h in re.findall(r'(\d{2,6})\s*:\s*["\']([a-f0-9]{8,32})["\']',t):out.add(urllib.parse.urljoin(base,f'chunks/{n}-{h}.js'))
 return out

def modules(t):
 for p in (r'(?:^|[,{}])([0-9]{2,8})\s*[:=]\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{',r'(?:^|[,{}])([0-9]{2,8})\s*:\s*function\s*\([^)]*\)\s*\{'):
  ms=list(re.finditer(p,t))
  if ms:break
 out={}
 for i,m in enumerate(ms):
  a=m.start(1);z=ms[i+1].start(1) if i+1<len(ms) else len(t)
  if 60<z-a<2_500_000:out[m.group(1)]=t[a:z]
 return out

def imports(t):return set(re.findall(r'(?<![\w$])r\(\s*(\d{2,8})\s*\)',t))
def hits(patterns,t):return {k:[m.start() for m in re.finditer(p,t,re.I)][:40] for k,p in patterns.items() if re.search(p,t,re.I)}
def around(t,pos,r=2600):return re.sub(r'\s+',' ',t[max(0,pos-r):min(len(t),pos+r)])
def apis(t):return sorted(set(re.findall(r'["\'](/(?:tapi|xapi|vas|api|defi|account|rebate|quotation)/[^"\'`\s]{1,180})["\']',t)))
def source_files(t):return sorted(set(re.findall(r'data-sentry-source-file["\']?\s*:\s*["\']([^"\']+)',t)))

def main():
 s,b,e=get(BASE,3_000_000);page=b.decode(errors='replace');mu,rs=manifest(page)
 q=deque(urls(page,BASE));[q.extend(v) for v in rs.values()];seen=set();allmods={};bund={}
 while q and len(seen)<MAX_BUNDLES:
  u=q.popleft()
  if u in seen or not u.startswith('https://gmgn.ai/'):continue
  seen.add(u);bs,bb,be=get(u)
  if bs!=200 or not bb:continue
  t=bb.decode(errors='replace');q.extend(x for x in dynamic(t,u) if x not in seen)
  for mid,mt in modules(t).items():
   if mid not in allmods or len(mt)>len(allmods[mid]):allmods[mid]=mt;bund[mid]=u
  time.sleep(.08)
 fw={m:imports(t) for m,t in allmods.items()};rev=defaultdict(set)
 for m,ds in fw.items():
  for d in ds:rev[d].add(m)
 inv=[]
 for mid,t in allmods.items():
  sh=hits(SINKS,t)
  if not sh:continue
  src=hits(SOURCES,t);san=hits(SAN,t);entries=[]
  for sink,positions in sh.items():
   for p in positions:
    w=around(t,p);entries.append({'sink':sink,'offset':p,'near_sources':list(hits(SOURCES,w)),'near_sanitizers':list(hits(SAN,w)),'snippet':w})
  parents=[]
  for par in sorted(rev.get(mid,set()))[:30]:
   pt=allmods.get(par,'');parents.append({'module':par,'bundle':bund.get(par),'source_files':source_files(pt),'apis':apis(pt),'snippet':around(pt,next((m.start() for m in re.finditer(rf'r\(\s*{mid}\s*\)',pt)),0),1800)})
  score=max((4*bool(x['near_sources'])+3*(x['sink'] in {'innerHTML','outerHTML','srcDoc','document.write','eval','newFunction'})-3*bool(x['near_sanitizers']) for x in entries),default=0)
  inv.append({'module':mid,'bundle':bund.get(mid),'bytes':len(t),'source_files':source_files(t),'sinks':list(sh),'sources':list(src),'sanitizers':list(san),'apis':apis(t),'score':score,'entries':entries,'parents':parents,'text':t[:800000]})
 inv.sort(key=lambda x:(x['score'],bool(x['source_files']),len(x['parents'])),reverse=True)
 rep={'generated_at':int(time.time()),'scope':'public static sink inventory','root':{'status':s,'error':e},'manifest':{'url':mu,'routes':len(rs)},'bundles':len(seen),'modules':len(allmods),'inventory':inv}
 Path('gmgn_xss_focus_report.json').write_text(json.dumps(rep,indent=2,ensure_ascii=False))
 lines=['# GMGN XSS Sink Inventory','',f'Bundles: **{len(seen)}**',f'Modules: **{len(allmods)}**',f'Sink modules: **{len(inv)}**','']
 for x in inv[:80]:lines.append(f"- score {x['score']} module `{x['module']}` sinks={x['sinks']} files={x['source_files']} parents={[p['module'] for p in x['parents'][:5]]}")
 Path('gmgn_xss_focus_verdict.md').write_text('\n'.join(lines)+'\n')
 print(json.dumps({'bundles':len(seen),'modules':len(allmods),'sink_modules':len(inv),'top':[{'module':x['module'],'score':x['score'],'sinks':x['sinks'],'files':x['source_files'],'parents':[p['module'] for p in x['parents'][:5]]} for x in inv[:35]]},indent=2))
if __name__=='__main__':main()
