#!/usr/bin/env python3
"""Inspect actual APKs/AAR with Android's APK Analyzer; never infer exclusion from runtime flags."""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile

root = Path(__file__).resolve().parents[2]
report_dir = root / 'artifacts/release-audit'
analyzer = Path(os.environ['ANDROID_HOME']) / 'cmdline-tools/latest/bin/apkanalyzer'
assert analyzer.is_file(), 'Install Android SDK command-line tools (apkanalyzer).'
report = json.loads((root / 'android/app/build/reports/networklog-release-dependencies.json').read_text())
expected_projects = {'project :app', 'project :demo-auth', 'project :logger-api'}
for name, dependencies in report.items():
    assert {x for x in dependencies if x.startswith('project ')} == expected_projects, (name, dependencies)
    assert all(x in expected_projects or x.startswith(('org.jetbrains.kotlin:kotlin-stdlib:', 'org.jetbrains:annotations:')) for x in dependencies), dependencies

api_jar = root / 'android/logger-api/build/libs/logger-api.jar'
with zipfile.ZipFile(api_jar) as jar:
    for name in jar.namelist():
        if name.endswith('/'):
            continue
        assert name.endswith('.class') or name.startswith('META-INF/'), name
        if name.endswith('.class'):
            assert name.startswith('dev/networklog/api/'), name
            data = jar.read(name)
            assert not any(marker in data for marker in [b'android/', b'org/json/', b'java/io/', b'java/net/', b'java/time/', b'java/security/', b'dev/networklog/logger/']), name
assert api_jar.stat().st_size < 64 * 1024, 'API grew beyond its small-abstraction size guard'
with zipfile.ZipFile(root / 'android/demo-auth/build/outputs/aar/demo-auth-release.aar') as aar:
    assert not any(name.startswith(('jni/', 'assets/')) for name in aar.namelist())
    with zipfile.ZipFile(io.BytesIO(aar.read('classes.jar'))) as jar:
        for name in jar.namelist():
            assert b'dev/networklog/logger/' not in jar.read(name), name

forbidden = [b'dev/networklog/logger/', b'certificate_sha256', b'capture_policy', b'http.body.captured', b'Pair desktop collector', b'connection.json', b'Capture spool', b'HTTPSequenceLogger', b'source_token', b'enrollment_token', b'_nlog._tcp', b'CollectorDiscovery', b'journal.json', b'source.json']
android = '{http://schemas.android.com/apk/res/android}'
backup_domains = {'root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'}


def verify_backup_rules(apk, app, variant):
    assert app.get(android + 'allowBackup') == 'false'
    for attribute, resource, root_tag, sections in [
        ('fullBackupContent', 'backup_rules', 'full-backup-content', [None]),
        ('dataExtractionRules', 'data_extraction_rules', 'data-extraction-rules', ['cloud-backup', 'device-transfer']),
    ]:
        assert app.get(android + attribute, '').startswith('@'), (variant, attribute)
        # Resource shrinking can rename the packaged XML file; resolve its path from the resource table.
        path = subprocess.check_output([str(analyzer), 'resources', 'value', '--config', 'default', '--type', 'xml', '--name', resource, str(apk)], text=True).strip()
        xml = subprocess.check_output([str(analyzer), 'resources', 'xml', '--file', path, str(apk)], text=True)
        (report_dir / f'{variant}-{resource}.xml').write_text(xml)
        rules = ET.fromstring(xml)
        assert rules.tag == root_tag, (variant, resource, rules.tag)
        for section in sections:
            policy = rules if section is None else rules.find(section)
            assert policy is not None and policy.find('include') is None, (variant, resource, section)
            excluded = {(item.get('domain'), item.get('path')) for item in policy.findall('exclude')}
            assert excluded == {(domain, '.') for domain in backup_domains}, (variant, resource, section, excluded)


results = {}
for variant, filename in [('debug', 'app-debug.apk'), ('release', 'app-release-unsigned.apk'), ('releaseUnminified', 'app-releaseUnminified-unsigned.apk')]:
    apk = root / 'android/app/build/outputs/apk' / variant / filename
    packages = subprocess.check_output([str(analyzer), 'dex', 'packages', '--defined-only', str(apk)], text=True)
    manifest = subprocess.check_output([str(analyzer), 'manifest', 'print', str(apk)], text=True)
    (report_dir / f'{variant}-dex.txt').write_text(packages)
    (report_dir / f'{variant}-manifest.xml').write_text(manifest)
    classes = [line.split('\t')[-1] for line in packages.splitlines() if line.startswith('C ')]
    recorder = [name for name in classes if name.startswith('dev.networklog.logger.')]
    with zipfile.ZipFile(apk) as contents:
        names = contents.namelist()
        debug_resource = any('network_log_debug_security' in name for name in names)
        payloads = [contents.read(name) for name in names if re.fullmatch(r'classes\d*\.dex', name)]
        assert payloads
        hits = [marker.decode() for marker in forbidden if any(marker in data for data in payloads)]
        assert not any(name.startswith('lib/') for name in names), 'Unexpected native dependency'
    app = ET.fromstring(manifest).find('application')
    verify_backup_rules(apk, app, variant)
    if variant == 'debug':
        assert recorder and hits and debug_resource, 'Missing positive control: debug recorder/resources'
        assert app.get(android + 'debuggable') == 'true'
    else:
        assert not recorder and not hits and not debug_resource, (variant, recorder, hits)
        assert app.get(android + 'debuggable', 'false') == 'false'
        assert app.get(android + 'networkSecurityConfig') is None
        assert app.get(android + 'usesCleartextTraffic') == 'false'
    package_line = next((line for line in packages.splitlines() if line.startswith('P ') and line.endswith('\tdev.networklog.api')), None)
    results[variant] = {'apk_bytes': apk.stat().st_size, 'recorder_classes': len(recorder), 'api_classes': len([n for n in classes if n.startswith('dev.networklog.api.')]), 'api_dex_bytes': int(package_line.split('\t')[-2]) if package_line else 0, 'debug_resources': debug_resource, 'backup_policy_verified': True}
configuration = (root / 'android/app/build/outputs/mapping/release/configuration.txt').read_text()
assert '-checkdiscard class dev.networklog.logger.**' in configuration
assert '-keep,allowshrinking class dev.networklog.logger.**' in configuration
result = {'passed': True, 'api_jar_bytes': api_jar.stat().st_size, 'runtime_dependencies': report, 'builds': results}
(report_dir / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
