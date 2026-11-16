"""Publish a stateless Canvas release. Browser data stays at the same HTTPS origin."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

ROOT = Path('/opt/canvas')
SHARED = ROOT / 'shared'

def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def run(args, **options):
    options.setdefault('check', True)
    return subprocess.run(args, **options)

def image_id(image):
    return subprocess.check_output(['docker','image','inspect',image,'--format','{{.Id}}'],text=True).strip()

def release_path(value):
    path = Path(value).resolve(strict=True)
    if path.parent != ROOT/'releases' or not re.fullmatch('[0-9a-f]{40}',path.name):
        raise ValueError('Expected a release directory identified by its Git commit')
    return path

def load_release(path,runtime):
    receipt=json.loads((path/'build-receipt.json').read_text())
    assert image_id('canvas:'+path.name)==receipt['image_id'] and receipt['tests_passed'] is True
    assert sha(path/'source-manifest.json')==receipt['manifest_sha256']
    assert image_id(runtime['image'])==runtime['image_id']==receipt['runtime_id']
    run(['python3',str(path/'source/deploy/source-snapshot.py'),'verify',path.name,str(path/'source'),str(path/'source-manifest.json')],stdout=subprocess.DEVNULL)
    for name in ['compose.yaml','deploy.sh','release.py']:
        assert sha(path/name)==sha(path/'source/deploy'/name), 'Release tooling differs from verified source'
    dependencies=json.loads((path/'source/package.json').read_text()).get('dependencies',{})
    assert 'pg' not in dependencies and not (path/'source/server/auth').exists(), 'Configure and validate database hosting before releasing the separate account-system changes'
    env=os.environ.copy();env['CANVAS_IMAGE']=receipt['image_id']
    return env

def compose(path,env,*args,**options):
    return run(['docker','compose','--project-name','canvas','--file',str(path/'compose.yaml'),*args],env=env,**options)

def healthy(path,env,timeout=120):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            cid=compose(path,env,'ps','-q','app',stdout=subprocess.PIPE).stdout.decode().strip()
            assert re.fullmatch('[0-9a-f]{12,64}',cid)
            state=json.loads(subprocess.check_output(['docker','inspect',cid]))[0]
            if state['Config']['Image']!=env['CANVAS_IMAGE'] or image_id(state['Config']['Image'])!=env['CANVAS_IMAGE'] or state['Config'].get('Labels',{}).get('org.opencontainers.image.revision')!=path.name:
                raise RuntimeError('Running image differs from verified release')
            if state['State'].get('Health',{}).get('Status')=='healthy':
                checked=run(['docker','exec',cid,'node','/app/verify-service.mjs'],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                if checked.returncode==0:return
        except (subprocess.CalledProcessError,AssertionError):
            pass
        time.sleep(2)
    raise RuntimeError('Canvas JSON health, static assets or backend validation failed')

def point(name,path):
    temporary=ROOT/(name+'.new')
    if temporary.is_symlink():temporary.unlink()
    assert not temporary.exists()
    temporary.symlink_to(path,target_is_directory=True)
    os.replace(temporary,ROOT/name)

def main():
    os.umask(0o077)
    assert os.geteuid()==0 and len(sys.argv)==2
    candidate=release_path(sys.argv[1])
    assert (SHARED/'deploy-ready').is_file(), 'Complete initial cutover before enabling automatic updates'
    with (SHARED/'release.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        current=release_path(ROOT/'current')
        runtime=json.loads((SHARED/'runtime-image.json').read_text())
        oldenv=load_release(current,runtime);newenv=load_release(candidate,runtime)
        previous=(ROOT/'previous').resolve(strict=True) if (ROOT/'previous').is_symlink() else None
        compose(candidate,newenv,'config','--quiet')
        if candidate==current:
            healthy(current,oldenv);print('This exact release is already healthy.');return
        def interrupted(number,frame):raise RuntimeError('Release interrupted by signal '+str(number))
        for number in [signal.SIGTERM,signal.SIGHUP]:signal.signal(number,interrupted)
        stopped=False
        try:
            stopped=True
            compose(current,oldenv,'stop','app')
            compose(candidate,newenv,'up','-d','--no-deps','--force-recreate','app')
            healthy(candidate,newenv)
            point('previous',current);point('current',candidate)
            audit=SHARED/'last-release.tmp'
            audit.write_text(json.dumps({'revision':candidate.name,'image_id':newenv['CANVAS_IMAGE'],'previous_revision':current.name,'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'business_backup_created':False},indent=2))
            os.replace(audit,SHARED/'last-release.json')
            print('Activated and verified '+candidate.name)
        except BaseException:
            if stopped:
                for number in [signal.SIGTERM,signal.SIGHUP,signal.SIGINT]:signal.signal(number,signal.SIG_IGN)
                compose(current,oldenv,'up','-d','--no-deps','--force-recreate','app')
                healthy(current,oldenv);point('current',current)
                if previous is not None:point('previous',previous)
                elif (ROOT/'previous').is_symlink():(ROOT/'previous').unlink()
                print('Previous Canvas application restored; browser data was not changed.',file=sys.stderr)
            raise

if __name__=='__main__':main()
