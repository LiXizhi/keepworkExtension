#!/usr/bin/env python3
"""Inspect actual locale resources; completeness is not translation certification."""
from pathlib import Path
import json, re, xml.etree.ElementTree as ET
root=Path(__file__).resolve().parents[2]
locales={'zh-CN','en-US','es-ES','ko-KR','ja-JP','fr-FR'}
ios=json.loads((root/'apps/ai-pet-ios/Sources/AIPetCore/Resources/development-copy.json').read_text())
assert set(ios)==locales
patterns=re.compile(r'%(?:\d+\$)?[-+0-9.]*[a-zA-Z@]')
def verify(catalog):
    baseline=next(iter(catalog.values()))
    for locale,entries in catalog.items():
        assert set(entries)==set(baseline),(locale,'key mismatch')
        for key,value in entries.items():
            assert value.strip(),(locale,key,'empty')
            assert sorted(patterns.findall(value))==sorted(patterns.findall(baseline[key])),(locale,key,'placeholder mismatch')
verify(ios)
android={}
for suffix in ['', '-zh-rCN','-es','-ko','-ja','-fr']:
    doc=ET.parse(root/f'apps/ai-pet-android/app/src/main/res/values{suffix}/strings.xml')
    nodes=doc.getroot().findall('string')
    values={node.attrib['name']:''.join(node.itertext()) for node in nodes}
    assert len(values)==len(nodes),'duplicate string key'
    android[suffix or 'default']=values
verify(android)
print(f'PASS iOS six locales / {len(next(iter(ios.values())))} keys; Android six locales / {len(next(iter(android.values())))} keys; nonempty and placeholder parity')
