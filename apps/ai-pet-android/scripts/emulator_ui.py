"""Fresh UI evidence and real, reversible control interaction for runtime harnesses."""
import uuid
import xml.etree.ElementTree as ET


def fresh_hierarchy(command, evidence):
    remote = '/sdcard/ai-pet-ui-' + uuid.uuid4().hex + '.xml'
    output = command(['shell','uiautomator','dump',remote])
    if b'dumped to:' not in output.lower() or remote.encode() not in output:
        raise RuntimeError('UI dump did not confirm its unique output path')
    xml = command(['exec-out','cat',remote])
    tree = ET.fromstring(xml)
    if tree.tag != 'hierarchy':
        raise RuntimeError('UI dump output is not a hierarchy')
    (evidence/(remote.rsplit('/',1)[-1])).write_bytes(xml)
    (evidence/'latest-ui.xml').write_bytes(xml)
    return tree


def toggle_round_trip(resource_id, locate, click, snapshot):
    def read():
        nodes = [n for n in snapshot().iter('node') if n.get('resource-id','').endswith('/'+resource_id)]
        if len(nodes)!=1 or nodes[0].get('checked') not in ('true','false'):
            raise AssertionError('Toggle state unavailable: '+resource_id)
        return nodes[0].get('checked')=='true'
    bounds = locate(resource_id)
    before = read()
    click(bounds)
    next_bounds = locate(resource_id)
    changed = read()
    if changed == before:
        raise AssertionError('Real toggle interaction did not change state')
    click(next_bounds)
    locate(resource_id)
    restored = read()
    if restored != before:
        raise AssertionError('Toggle state did not restore')
    return {'control':resource_id,'before':before,'afterClick':changed,'restored':restored}


def assert_app_surface(tree, package):
    nodes=list(tree.iter('node'))
    if any(n.get('resource-id','').startswith('android:id/aerr_') for n in nodes):
        raise AssertionError('ANR dialog blocks application')
    if not any(n.get('package')==package and (n.get('text') or n.get('resource-id','').startswith(package+':id/')) for n in nodes):
        raise AssertionError('Actual application UI absent (launcher/other surface)')
    return tree


def assert_resumed(state, package):
    import re
    if not re.search(r'(?:topResumedActivity|mResumedActivity)[^\n]*'+re.escape(package)+r'/\.MainActivity',state):
        raise AssertionError('Application is not resumed foreground Activity')
