import json,subprocess,sys,os
harness=sys.argv[1]; env=dict(os.environ); env['OA_BUS_CLAUDE_SESSIONS_DIR']=sys.argv[2]
p=subprocess.Popen(['oa-bus','mcp',harness],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env,cwd='/')
def rpc(i,m,params=None):
    msg={'jsonrpc':'2.0','method':m}; 
    if i is not None: msg['id']=i
    if params is not None: msg['params']=params
    p.stdin.write(json.dumps(msg)+'\n'); p.stdin.flush()
    if i is None: return
    return json.loads(p.stdout.readline())
r=rpc(1,'initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'claude-ai','version':'0.1.0'}})
print('initialize ->',r['result']['serverInfo'],r['result']['capabilities'])
rpc(None,'notifications/initialized')
r=rpc(2,'tools/list'); print('tools ->',[t['name'] for t in r['result']['tools']])
r=rpc(3,'tools/call',{'name':'self','arguments':{}}); print('self ->',json.dumps(r.get('result',r.get('error')))[:400])
p.kill()
