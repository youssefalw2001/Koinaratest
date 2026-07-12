from __future__ import annotations
import html,json,re,time,urllib.error,urllib.parse,urllib.request
from collections import deque
from pathlib import Path

BASE='https://gmgn.ai/'
UA='Mozilla/5.0 Chrome/124 Safari/537.36'
TARGETS={'851736','381304','582551','259896','933978','961002','118418','410221','277891','149781','943347','692696','451154','593195','981017'}


def get(url,limit=20_000_000):
    req=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/javascript,*/*'})
    try:
        with urllib.request.urlopen(req,timeout=35) as resp:
            return resp.status,resp.read(limit+1)[:limit],None
    except urllib.error.HTTPError as exc:
        return exc.code,exc.read(200000),str(exc)
    except Exception as exc:
        return None,b'',f'{type(exc).__name__}: {exc}'


def scripts(text,base):
    out=set()
    for pattern in (r'<script[^>]+src=["\']([^"\']+)["\']',r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']'):
        for match in re.finditer(pattern,text,re.I):
            url=urllib.parse.urljoin(base,html.unescape(match.group(1)))
            if url.startswith('https://gmgn.ai/') and (urllib.parse.urlparse(url).path.endswith('.js') or '.js?' in url):out.add(url)
    return out


def manifest(text):
    match=re.search(r'["\'](/_next/static/[^"\']+/_buildManifest\.js)["\']',text)
    if not match:return None,{}
    url=urllib.parse.urljoin(BASE,match.group(1));status,body,error=get(url,8_000_000)
    if status!=200:return url,{}
    source=body.decode(errors='replace');routes={}
    for item in re.finditer(r'["\'](/[^"\']*)["\']\s*:\s*\[([^\]]*)\]',source):
        chunks=re.findall(r'["\']([^"\']+\.js)["\']',item.group(2))
        if chunks:routes[item.group(1)]=[urllib.parse.urljoin(url,x) for x in chunks]
    return url,routes


def dynamic(text,url):
    out=set(urllib.parse.urljoin(url,x) for x in re.findall(r'["\']([^"\']*(?:chunks|pages)/[^"\']+\.js)["\']',text))
    root=re.match(r'(https://[^/]+/_next/static/)',url);base=root.group(1) if root else urllib.parse.urljoin(url,'/_next/static/')
    for number,digest in re.findall(r'(\d{2,6})\s*:\s*["\']([a-f0-9]{8,32})["\']',text):out.add(urllib.parse.urljoin(base,f'chunks/{number}-{digest}.js'))
    return out


def split_modules(text):
    patterns=(r'(?:^|[,{}])([0-9]{2,8})\s*[:=]\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{',r'(?:^|[,{}])([0-9]{2,8})\s*:\s*function\s*\([^)]*\)\s*\{')
    matches=[]
    for pattern in patterns:
        matches=list(re.finditer(pattern,text))
        if matches:break
    out={}
    for index,match in enumerate(matches):
        start=match.start(1);end=matches[index+1].start(1) if index+1<len(matches) else len(text)
        if 60<end-start<3_000_000:out[match.group(1)]=text[start:end]
    return out


def context(text,pos,radius=2500):return re.sub(r'\s+',' ',text[max(0,pos-radius):min(len(text),pos+radius)])


def main():
    status,body,error=get(BASE,3_000_000);page=body.decode(errors='replace');manifest_url,routes=manifest(page)
    queue=deque(scripts(page,BASE));[queue.extend(values) for values in routes.values()]
    seen=set();found={};callers={target:[] for target in TARGETS}
    while queue and len(seen)<360:
        url=queue.popleft()
        if url in seen or not url.startswith('https://gmgn.ai/'):continue
        seen.add(url);b_status,b_body,b_error=get(url)
        if b_status!=200 or not b_body:continue
        text=b_body.decode(errors='replace');queue.extend(x for x in dynamic(text,url) if x not in seen)
        mods=split_modules(text)
        for target in TARGETS:
            if target in mods:found[target]={'bundle':url,'bytes':len(mods[target]),'text':mods[target]}
            for match in list(re.finditer(rf'(?<![\w$])r\(\s*{target}\s*\)',text))[:30]:
                callers[target].append({'bundle':url,'offset':match.start(),'context':context(text,match.start())})
        if TARGETS.issubset(found):break
        time.sleep(.08)
    report={'generated_at':int(time.time()),'scope':'public static helper extraction','root':{'status':status,'error':error},'manifest':{'url':manifest_url,'routes':len(routes)},'bundles_scanned':len(seen),'modules':found,'callers':callers,'summary':{'targets':len(TARGETS),'found':len(found),'bundles':len(seen)},'candidates':[],'canaries':[]}
    Path('gmgn_xss_focus_report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False))
    lines=['# GMGN WebSocket Serializer Extraction','',f"Targets found: **{len(found)}/{len(TARGETS)}**",'']
    for target in sorted(TARGETS):lines.append(f"- `{target}`: {'found' if target in found else 'missing'}, callers={len(callers[target])}")
    Path('gmgn_xss_focus_verdict.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(report['summary'],indent=2))

if __name__=='__main__':main()
