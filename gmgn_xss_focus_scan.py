from __future__ import annotations
import html,json,re,time,urllib.error,urllib.parse,urllib.request
from collections import deque
from pathlib import Path
BASE='https://gmgn.ai/'
UA='Mozilla/5.0 Chrome/124 Safari/537.36'
TARGETS={'353850','484811','688884','752157','461617','524279'}

def get(u,limit=18_000_000):
 req=urllib.request.Request(u,headers={'User-Agent':UA,'Accept':'text/html,application/javascript,*/*'})
 try:
  with urllib.request.urlopen(req,timeout=35) as r:return r.status,r.read(limit+1)[:limit],None
 except urllib.error.HTTPError as e:return e.code,e.read(200000),str(e)
 except Exception as e:return None,b'',f'{type(e).__name__}: {e}'

def scripts(t,base):
 out=set()
 for p in (r'<script[^>]+src=["\']([^"\']+)["\']',r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']'):
  for m in re.finditer(p,t,re.I):
   u=urllib.parse.urljoin(base,html.unescape(m.group(1)))
   if u.startswith('https://gmgn.ai/') and (urllib.parse.urlparse(u).path.endswith('.js') or '.js?' in u):out.add(u)
 return out

def manifest(t):
 m=re.search(r'["\'](/_next/static/[^"\']+/_buildManifest\.js)["\']',t)
 if not m:return None,{}
 u=urllib.parse.urljoin(BASE,m.group(1));s,b,e=get(u,6_000_000)
 if s!=200:return u,{}
 x=b.decode(errors='replace');out={}
 for q in re.finditer(r'["\'](/[^"\']*)["\']\s*:\s*\[([^\]]*)\]',x):
  js=re.findall(r'["\']([^"\']+\.js)["\']',q.group(2))
  if js:out[q.group(1)]=[urllib.parse.urljoin(u,z) for z in js]
 return u,out

def chunks(t,u):
 out=set(urllib.parse.urljoin(u,x) for x in re.findall(r'["\']([^"\']*(?:chunks|pages)/[^"\']+\.js)["\']',t))
 root=re.match(r'(https://[^/]+/_next/static/)',u);base=root.group(1) if root else urllib.parse.urljoin(u,'/_next/static/')
 for i,h in re.findall(r'(\d{2,6})\s*:\s*["\']([a-f0-9]{8,32})["\']',t):out.add(urllib.parse.urljoin(base,f'chunks/{i}-{h}.js'))
 return out

def modules(t):
 ms=list(re.finditer(r'(?:^|[,{}])([0-9]{2,8})\s*[:=]\s*(?:\([^)]*\)|\w+)\s*=>\s*\{',t))
 if not ms:ms=list(re.finditer(r'(?:^|[,{}])([0-9]{2,8})\s*:\s*function\s*\([^)]*\)\s*\{',t))
 out={}
 for i,m in enumerate(ms):
  a=m.start(1);z=ms[i+1].start(1) if i+1<len(ms) else len(t)
  if m.group(1) in TARGETS:out[m.group(1)]=t[a:z]
 return out

def near(t,p,r=1200):return re.sub(r'\s+',' ',t[max(0,p-r):min(len(t),p+r)])

def main():
 s,b,e=get(BASE,3_000_000);page=b.decode(errors='replace');mu,routes=manifest(page)
 q=deque(scripts(page,BASE));[q.extend(v) for v in routes.values()];seen=set();mods={};refs={x:[] for x in TARGETS};named=[]
 while q and len(seen)<260:
  u=q.popleft()
  if u in seen or not u.startswith('https://gmgn.ai/'):continue
  seen.add(u);bs,bb,be=get(u)
  if bs!=200 or not bb:continue
  t=bb.decode(errors='replace');q.extend(x for x in chunks(t,u) if x not in seen)
  for mid,text in modules(t).items():mods[mid]={'bundle':u,'bytes':len(text),'text':text[:650000]}
  for mid in TARGETS:
   for m in re.finditer(rf'\b[A-Za-z_$][\w$]*\(\s*{mid}\s*\)',t):refs[mid].append({'bundle':u,'offset':m.start(),'snippet':near(t,m.start())})
  for name in ('AutoPauseVideo','_rk_coolMode','srcDoc','coolMode','isSafeUrl','getTargetUrl'):
   for m in list(re.finditer(name,t))[:8]:named.append({'name':name,'bundle':u,'offset':m.start(),'snippet':near(t,m.start())})
  time.sleep(.12)
 analysis={}
 for mid,item in mods.items():
  t=item['text'];a={}
  if mid=='688884':
   a['srcdoc_variables']=re.findall(r'srcDoc\s*:\s*([A-Za-z_$][\w$]*)',t)
   a['assignments_to_j']=[m.group(0)[:1400] for m in re.finditer(r'(?:let|const|var)?\s*j\s*=\s*[^;]{1,1300}',t)]
   a['component_head']=t[:8000]
  if mid=='484811':
   a['innerhtml_templates']=[m.group(0)[:1800] for m in re.finditer(r'\.innerHTML\s*=\s*`[^`]{1,1700}`',t)]
   a['e0_definitions']=[m.group(0)[:2500] for m in re.finditer(r'e0\s*=\s*[^;]{1,2400}',t)]
   a['n7_calls']=[m.group(0)[:1200] for m in re.finditer(r'n7\s*\([^)]{1,1100}\)',t)]
  if mid=='353850':a['safe_url_module']=t[:18000]
  analysis[mid]=a
 rep={'generated_at':int(time.time()),'root_status':s,'root_error':e,'manifest':mu,'routes':len(routes),'bundles':len(seen),'modules':mods,'references':refs,'named_hits':named[:500],'analysis':analysis}
 Path('gmgn_xss_focus_report.json').write_text(json.dumps(rep,indent=2,ensure_ascii=False))
 lines=['# GMGN XSS Module Trace','',f"Bundles scanned: **{len(seen)}**",f"Target modules extracted: **{len(mods)}**",'']
 for mid,x in mods.items():lines.append(f"- `{mid}` from `{x['bundle']}` — {x['bytes']} bytes, references={len(refs[mid])}")
 Path('gmgn_xss_focus_verdict.md').write_text('\n'.join(lines)+'\n')
 print(json.dumps({'bundles':len(seen),'modules':{k:{'bundle':v['bundle'],'bytes':v['bytes'],'references':len(refs[k])} for k,v in mods.items()}},indent=2))

if __name__=='__main__':main()
