#!/usr/bin/env python3
"""Owned test-artifact staging only. Never remove attrs, re-sign or execute input."""
import argparse,ctypes,hashlib,json,os,pathlib,stat,struct,subprocess,sys
sha=lambda b:hashlib.sha256(b).hexdigest()
class StageError(RuntimeError):
    def __init__(self,message,evidence=None):super().__init__(message);self.evidence=evidence or {}
def run(args):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
    if p.returncode:raise StageError('metadata/copy operation denied or failed',{'command':args,'exit_code':p.returncode,'stderr':p.stderr.decode(errors='replace')[:4096]})
    return p.stdout
def birthtime_ns(path):
    # Darwin returns a packed timespec; avoid losing nanoseconds via float stat fields.
    class AttrList(ctypes.Structure):
        _fields_=[('count',ctypes.c_uint16),('reserved',ctypes.c_uint16),('common',ctypes.c_uint32),('volume',ctypes.c_uint32),('directory',ctypes.c_uint32),('file',ctypes.c_uint32),('fork',ctypes.c_uint32)]
    attrs=AttrList(5,0,0x200,0,0,0,0);buffer=ctypes.create_string_buffer(64);libc=ctypes.CDLL(None,use_errno=True)
    call=libc.getattrlist;call.argtypes=[ctypes.c_char_p,ctypes.POINTER(AttrList),ctypes.c_void_p,ctypes.c_size_t,ctypes.c_ulong];call.restype=ctypes.c_int
    if call(os.fsencode(path),ctypes.byref(attrs),buffer,len(buffer),1):raise OSError(ctypes.get_errno(),'birth-time metadata read denied',str(path))
    length=struct.unpack_from('=I',buffer.raw)[0]
    if length!=20:raise StageError('unexpected Darwin birth-time metadata layout')
    sec,nsec=struct.unpack_from('=qq',buffer.raw,4)
    if not 0<=nsec<1000000000:raise StageError('invalid birth-time nanoseconds')
    return str(sec*1000000000+nsec)
def snapshot(path):
    path=pathlib.Path(path);s=path.lstat()
    if not stat.S_ISREG(s.st_mode) or path.is_symlink():raise StageError('source/destination must be a regular non-symlink file')
    names=run(['/usr/bin/xattr',str(path)]).decode().splitlines()
    if len(names)>64 or any(not n or any(ord(c)<32 for c in n) for n in names):raise StageError('unexpected attribute names')
    attrs={}
    for name in sorted(names):
        encoded=run(['/usr/bin/xattr','-px',name,str(path)])
        if len(encoded)>4*1024*1024:raise StageError('attribute exceeds bounded diagnostic size')
        value=bytes.fromhex(encoded.decode());attrs[name]={'bytes':len(value),'sha256':sha(value)}
    acl=run(['/bin/ls','-lde',str(path)]).decode().splitlines()[1:]
    return {'path':str(path),'sha256':sha(path.read_bytes()),'inode':s.st_ino,'device':s.st_dev,'size':s.st_size,'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid,'mtime_ns':str(s.st_mtime_ns),'birthtime_ns':birthtime_ns(path),'flags':s.st_flags,'attributes':attrs,'acl_entries':len(acl),'acl_sha256':sha('\n'.join(acl).encode())}
def comparable(s):return {k:v for k,v in s.items() if k not in ['path','inode','device']}
def stage(source,destination,owned_root,expected_sha):
    source=pathlib.Path(source);destination=pathlib.Path(destination);root=pathlib.Path(owned_root)
    if root.is_symlink() or root.resolve()!=root or not root.is_dir() or root.stat().st_uid!=os.getuid() or stat.S_IMODE(root.stat().st_mode)!=0o700:raise StageError('require canonical owned private root')
    if '/Desktop/' in str(root) or '/Desktop/' in str(destination):raise StageError('staged executable must be outside Desktop')
    if destination.parent!=root or destination.exists() or destination.is_symlink():raise StageError('destination must be a new direct child of owned root')
    before=snapshot(source)
    if before['sha256']!=expected_sha or not before['mode']&0o111 or before['mode']&0o6000 or before['uid']!=os.getuid():raise StageError('unexpected source identity/mode/owner',{'source_before':before})
    args=['/usr/bin/ditto','--rsrc','--extattr','--qtn','--acl','--preserveHFSCompression',str(source),str(destination)]
    try:run(args)
    except StageError as e:e.evidence={'source_before':before,**e.evidence};raise
    after=snapshot(source);copy=snapshot(destination);group_restore=None
    if before['gid']!=copy['gid']:
        # Ordinary group preservation only: same uid, already-owned file, member gid.
        fields=lambda s:{k:v for k,v in comparable(s).items() if k!='gid'}
        if fields(before)!=fields(copy):raise StageError('metadata mismatch beyond inherited group; do not correct',{'source_before':before,'staged_before_group':copy})
        if before['gid'] not in set(os.getgroups())|{os.getgid()}:raise StageError('source group not in current membership',{'source_before':before,'staged_before_group':copy})
        fd=os.open(destination,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            s=os.fstat(fd)
            if s.st_uid!=os.getuid() or not stat.S_ISREG(s.st_mode) or (s.st_ino,s.st_dev)!=(copy['inode'],copy['device']) or s.st_mode&0o6000:raise StageError('unsafe staged descriptor/owner/set-ID mode')
            try:os.fchown(fd,-1,before['gid'])
            except OSError as e:raise StageError('owned group preservation denied',{'source_before':before,'staged_before_group':copy,'errno':e.errno}) from e
            group_restore={'operation':'unprivileged fchown(fd, -1, source_gid)','uid_unchanged':s.st_uid,'from_gid':s.st_gid,'to_gid':before['gid']}
        finally:os.close(fd)
        copy=snapshot(destination)
    evidence={'source_before':before,'source_after':after,'staged':copy,'copy_command':args,'group_restore':group_restore,'copy_policy':'preserve resource forks/extended attrs/quarantine/ACL/compression; no removal, thinning or signing','metadata_comparison_exclusions':['path','inode','device','access/ctime: ordinary read/copy bookkeeping, not deliberately modified']}
    if before!=after:raise StageError('source changed during staging',evidence)
    if before['inode']==copy['inode'] and before['device']==copy['device']:raise StageError('destination aliases original inode',evidence)
    if comparable(before)!=comparable(copy):raise StageError('metadata/security-attribute preservation mismatch; do not bypass',evidence)
    return {'status':'pass',**evidence,'source_immutable':True,'metadata_equal':True,'bytes_equal':True}
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source');parser.add_argument('--destination');parser.add_argument('--owned-root');parser.add_argument('--expected-sha256');parser.add_argument('--snapshot');a=parser.parse_args()
    if not a.snapshot and not all([a.source,a.destination,a.owned_root,a.expected_sha256]):parser.error('stage requires source/destination/owned-root/expected-sha256')
    try:result={'status':'pass','snapshot':snapshot(a.snapshot)} if a.snapshot else stage(a.source,a.destination,a.owned_root,a.expected_sha256)
    except (Exception,) as e:print(json.dumps({'status':'blocked','error':str(e),'evidence':getattr(e,'evidence',{})}));sys.exit(1)
    print(json.dumps(result))
