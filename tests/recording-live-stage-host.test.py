import importlib.util,pathlib,tempfile,unittest,os,hashlib,subprocess,sys
spec=importlib.util.spec_from_file_location('stage',pathlib.Path(__file__).with_name('recording-live-stage-host.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
@unittest.skipUnless(sys.platform=='darwin','metadata-preserving staging is macOS-specific')
class StageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='recording-stage-',dir='/tmp');self.root=pathlib.Path(self.temp.name).resolve();os.chmod(self.root,0o700)
        self.source=self.root/'fixture-input';self.source.write_bytes(b'not executed: synthetic staging fixture\n');os.chmod(self.source,0o751);os.chown(self.source,-1,os.getgid());self.digest=hashlib.sha256(self.source.read_bytes()).hexdigest()
    def tearDown(self):self.temp.cleanup()
    def test_exact_bytes_mode_dates_acl_xattrs_and_original_immutable(self):
        # Only an innocuous attribute on this owned synthetic fixture; never security attrs.
        subprocess.run(['/usr/bin/xattr','-w','org.apbrowser.live_stage_test','owned-test-value',str(self.source)],check=True,capture_output=True)
        before=module.snapshot(self.source);r=module.stage(self.source,self.root/'staged',self.root,self.digest)
        self.assertEqual(r['status'],'pass');self.assertEqual(module.snapshot(self.source),before);self.assertEqual(r['staged']['mode'],0o751)
        self.assertEqual(r['staged']['attributes'],before['attributes']);self.assertEqual(r['staged']['mtime_ns'],before['mtime_ns']);self.assertTrue(r['source_immutable']);self.assertIsInstance(before['mtime_ns'],str);self.assertIsInstance(before['birthtime_ns'],str)
        if self.root.stat().st_gid!=before['gid']:
            self.assertEqual(r['group_restore']['to_gid'],before['gid']);self.assertEqual(r['group_restore']['from_gid'],self.root.stat().st_gid)
    def test_reject_symlink_unexpected_hash_and_existing_destination(self):
        link=self.root/'link';link.symlink_to(self.source)
        with self.assertRaisesRegex(module.StageError,'non-symlink'):module.stage(link,self.root/'copy1',self.root,self.digest)
        with self.assertRaisesRegex(module.StageError,'unexpected source'):module.stage(self.source,self.root/'copy2',self.root,'0'*64)
        with self.assertRaisesRegex(module.StageError,'new direct child'):module.stage(self.source,self.source,self.root,self.digest)
        self.assertFalse((self.root/'copy1').exists());self.assertFalse((self.root/'copy2').exists())
    def test_group_membership_and_denial_fail_closed(self):
        from unittest.mock import patch
        if self.root.stat().st_gid==self.source.stat().st_gid:self.skipTest('fixture parent already has source group')
        before=module.snapshot(self.source)
        with patch.object(module.os,'getgroups',return_value=[]),patch.object(module.os,'getgid',return_value=-1):
            with self.assertRaisesRegex(module.StageError,'membership'):module.stage(self.source,self.root/'nonmember',self.root,self.digest)
        with patch.object(module.os,'fchown',side_effect=PermissionError(1,'simulated owned-file denial')):
            with self.assertRaisesRegex(module.StageError,'preservation denied'):module.stage(self.source,self.root/'denied',self.root,self.digest)
        self.assertEqual(module.snapshot(self.source),before)
    def test_mismatch_is_blocked_not_silently_cleared(self):
        # Verify fail-closed comparison with synthetic snapshots, no attr removal.
        from unittest.mock import patch
        before=module.snapshot(self.source);copy={**before,'path':str(self.root/'copy'),'inode':before['inode']+1,'attributes':{}}
        before={**before,'attributes':{'org.apbrowser.synthetic':{'bytes':1,'sha256':'synthetic'}}}
        with patch.object(module,'snapshot',side_effect=[before,before,copy]),patch.object(module,'run',return_value=b''):
            with self.assertRaisesRegex(module.StageError,'preservation mismatch'):module.stage(self.source,self.root/'copy',self.root,self.digest)
if __name__=='__main__':unittest.main()
