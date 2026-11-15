#!/usr/bin/env python3
"""Validate shipping development resource completeness and formatting, not translation quality."""
import pathlib, re, xml.etree.ElementTree as ET
root = pathlib.Path(__file__).resolve().parents[1] / 'app/src/main/res'
def read(folder):
    elements = ET.parse(root / folder / 'strings.xml').getroot().findall('string')
    result = {node.attrib['name']: ''.join(node.itertext()) for node in elements}
    assert len(result) == len(elements), f'Duplicate strings: {folder}'
    return result
baseline = read('values')
for folder in ['values-zh-rCN','values-es','values-ko','values-ja','values-fr']:
    localized = read(folder)
    assert localized.keys() == baseline.keys(), f'Missing/extra keys: {folder}'
    for key, value in localized.items():
        assert value.strip(), f'Empty string: {folder}/{key}'
        assert re.findall(r'%\d+\$[sd]',value) == re.findall(r'%\d+\$[sd]',baseline[key]), f'Format mismatch: {folder}/{key}'
print(f'PASS six complete locales, {len(baseline)} string keys each; format placeholders match')
