from __future__ import annotations
import html,json,re,time,urllib.error,urllib.parse,urllib.request
from collections import defaultdict,deque
from pathlib import Path

BASE='https://gmgn.ai/'
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
TARGETS={'688884','484811'}
MAX_BUNDLES=300
MAX_BYTES=18_000_000


def get(url,limit=MAX_BYTES):
    req=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/javascript,*/*;q=.8'})
    try:
        with urllib.request.urlopen(req,timeout=35) as resp:
            return resp.status,resp.read(limit+1)[:limit],None
    except urllib.error.HTTPError as exc:
        return exc.code,exc.read(200000),str(exc)
    except Exception as exc:
        return None,b'',f'{type(exc).__name__}: {exc}'


def script_urls(text,base):
    out=set()
    for pattern in (r'<script[^>]+src=["\']([^"\']+)["\']',r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']'):
        for match in re.finditer(pattern,text,re.I):
            url=urllib.parse.urljoin(base,html.unescape(match.group(1)))
            if url.startswith('https://gmgn.ai/') and (urllib.parse.urlparse(url).path.endswith('.js') or '.js?' in url):out.add(url)
    return out


def manifest_routes(text):
    match=re.search(r'["\'](/_next/static/[^"\']+/_buildManifest\.js)["\']',text)
    if not match:return None,{}
    url=urllib.parse.urljoin(BASE,match.group(1));status,body,error=get(url,7_000_000)
    if status!=200:return url,{}
    source=body.decode(errors='replace');routes={}
    for item in re.finditer(r'["\'](/[^"\']*)["\']\s*:\s*\[([^\]]*)\]',source):
        chunks=re.findall(r'["\']([^"\']+\.js)["\']',item.group(2))
        if chunks:routes[item.group(1)]=[urllib.parse.urljoin(url,x) for x in chunks]
    return url,routes


def dynamic_chunks(text,url):
    out=set(urllib.parse.urljoin(url,x) for x in re.findall(r'["\']([^"\']*(?:chunks|pages)/[^"\']+\.js)["\']',text))
    root=re.match(r'(https://[^/]+/_next/static/)',url);base=root.group(1) if root else urllib.parse.urljoin(url,'/_next/static/')
    for number,digest in re.findall(r'(\d{2,6})\s*:\s*["\']([a-f0-9]{8,32})["\']',text):
        out.add(urllib.parse.urljoin(base,f'chunks/{number}-{digest}.js'))
    return out


def split_modules(text):
    patterns=[r'(?:^|[,{}])([0-9]{2,8})\s*[:=]\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{',r'(?:^|[,{}])([0-9]{2,8})\s*:\s*function\s*\([^)]*\)\s*\{']
    matches=[]
    for pattern in patterns:
        matches=list(re.finditer(pattern,text))
        if matches:break
    result={}
    for index,match in enumerate(matches):
        start=match.start(1);end=matches[index+1].start(1) if index+1<len(matches) else len(text)
        if 60<end-start<2_500_000:result[match.group(1)]=text[start:end]
    return result


def imports(text):
    return set(re.findall(r'(?<![\w$])r\(\s*(\d{2,8})\s*\)',text))


def api_literals(text):
    return sorted(set(re.findall(r'["\'](/(?:tapi|xapi|vas|api|defi|account|rebate|quotation)/[^"\'`\s]{1,180})["\']',text)))


def snippets(text,patterns,limit=30,radius=1800):
    out=[]
    for name,pattern in patterns.items():
        for match in list(re.finditer(pattern,text,re.I))[:limit]:
            lo=max(0,match.start()-radius);hi=min(len(text),match.end()+radius)
            out.append({'name':name,'offset':match.start(),'snippet':re.sub(r'\s+',' ',text[lo:hi])})
    return out


def main():
    status,body,error=get(BASE,3_000_000);page=body.decode(errors='replace')
    manifest_url,routes=manifest_routes(page)
    queue=deque(script_urls(page,BASE));[queue.extend(values) for values in routes.values()]
    seen=set();modules={};module_bundle={};bundle_errors=[]
    while queue and len(seen)<MAX_BUNDLES:
        url=queue.popleft()
        if url in seen or not url.startswith('https://gmgn.ai/'):continue
        seen.add(url);b_status,b_body,b_error=get(url)
        if b_status!=200 or not b_body:
            bundle_errors.append({'url':url,'status':b_status,'error':b_error});continue
        text=b_body.decode(errors='replace')
        queue.extend(x for x in dynamic_chunks(text,url) if x not in seen)
        for module_id,module_text in split_modules(text).items():
            if module_id not in modules or len(module_text)>len(modules[module_id]):
                modules[module_id]=module_text;module_bundle[module_id]=url
        time.sleep(.1)

    forward={module_id:imports(text) for module_id,text in modules.items()}
    reverse=defaultdict(set)
    for module_id,deps in forward.items():
        for dep in deps:reverse[dep].add(module_id)

    depths={target:0 for target in TARGETS};frontier=deque(TARGETS)
    while frontier:
        child=frontier.popleft();depth=depths[child]
        if depth>=6:continue
        for parent in reverse.get(child,set()):
            if parent not in depths or depth+1<depths[parent]:
                depths[parent]=depth+1;frontier.append(parent)

    selected=sorted(depths,key=lambda item:(depths[item],item))
    patterns={
        'srcdoc':r'\bsrcDoc\b|\.srcdoc\b','innerhtml':r'\.innerHTML\s*=','dangerous':r'dangerouslySetInnerHTML',
        'video_props':r'(?:src|poster|url)\s*:\s*[^,}\]]+','item_url':r'\bitem\.(?:url|poster|src)\b|\w+\.(?:url|poster)\b',
        'api_call':r'(?:\.get|\.post)\s*\(\s*\{[^}]{0,500}url\s*:','user_fields':r'\b(?:content|description|bio|message|text|html|markdown|url|poster|media|video|image)\b',
        'target_import':r'r\(\s*(?:688884|484811)\s*\)','jsx_call':r'(?:jsx|jsxs|createElement)\s*\([^)]{0,1200}'
    }
    extracted={}
    for module_id in selected[:180]:
        text=modules.get(module_id,'')
        extracted[module_id]={
            'depth':depths[module_id],'bundle':module_bundle.get(module_id),'bytes':len(text),
            'imports':sorted(forward.get(module_id,set())),'api_literals':api_literals(text),
            'signals':snippets(text,patterns,limit=20,radius=2200),'text':text[:900000]
        }

    # Also select every module containing an API endpoint and a URL/media field that is within the reverse closure.
    endpoint_modules=[]
    for module_id in selected:
        text=modules.get(module_id,'');apis=api_literals(text)
        if apis and re.search(r'\b(?:url|poster|media|video|image|content|description)\b',text,re.I):
            endpoint_modules.append({'module':module_id,'depth':depths[module_id],'bundle':module_bundle.get(module_id),'apis':apis,'snippets':snippets(text,{'fields':r'\b(?:url|poster|media|video|image|content|description)\b','api':r'/(?:tapi|xapi|vas|api|defi|account|rebate)/'},15,1800)})

    report={
        'generated_at':int(time.time()),'scope':'public frontend call-graph analysis only','root':{'status':status,'error':error},
        'manifest':{'url':manifest_url,'routes':len(routes)},'bundles':len(seen),'module_count':len(modules),'bundle_errors':bundle_errors[:30],
        'targets':sorted(TARGETS),'reverse_depths':depths,'selected_modules':extracted,'endpoint_modules':endpoint_modules
    }
    Path('gmgn_xss_focus_report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False))
    lines=['# GMGN XSS Call Graph','',f'Bundles scanned: **{len(seen)}**',f'Modules parsed: **{len(modules)}**',f'Reverse-closure modules: **{len(selected)}**','']
    for target in sorted(TARGETS):
        lines.append(f'- target `{target}` direct parents: {sorted(reverse.get(target,set()))}')
    lines.append('')
    for item in endpoint_modules[:30]:lines.append(f"- depth {item['depth']} module `{item['module']}` APIs: {', '.join(item['apis'])}")
    Path('gmgn_xss_focus_verdict.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps({'bundles':len(seen),'modules':len(modules),'closure':len(selected),'targets':{t:sorted(reverse.get(t,set())) for t in TARGETS},'endpoint_modules':[(x['module'],x['depth'],x['apis']) for x in endpoint_modules[:20]]},indent=2))

if __name__=='__main__':main()
