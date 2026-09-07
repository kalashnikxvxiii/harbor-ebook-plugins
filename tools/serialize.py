import sys, json
from html.parser import HTMLParser
DROP={'script','style','noscript','template','iframe','object','embed','link','meta'}
VOID={'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
class P(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True)
        s.root={"t":"body","a":{},"x":"","c":[]}
        s.stack=[s.root]; s.skip=0
    def handle_starttag(s,tag,attrs):
        if s.skip: 
            if tag not in VOID: s.skip+=1
            return
        if tag in DROP or tag=='head':
            if tag not in VOID: s.skip=1
            return
        n={"t":tag,"a":{k:(v or "") for k,v in attrs},"x":"","c":[]}
        if tag in VOID: s.stack[-1]["c"].append(n); return
        s.stack[-1]["c"].append(n); s.stack.append(n)
    def handle_endtag(s,tag):
        if s.skip:
            s.skip-=1; return
        if tag in VOID: return
        for i in range(len(s.stack)-1,0,-1):
            if s.stack[i]["t"]==tag: del s.stack[i:]; return
    def handle_data(s,d):
        if s.skip or not d.strip(): return
        s.stack[-1]["c"].append({"x":d})
p=P(); p.feed(sys.stdin.read())
json.dump(p.root, sys.stdout)
