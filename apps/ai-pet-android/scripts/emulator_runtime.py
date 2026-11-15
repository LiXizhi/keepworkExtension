"""Bounded readiness loop shared by the owned-emulator harness and its regression test."""
import subprocess
import time


def wait_for_stage(name, probe, budget, records, now=time.monotonic, sleep=time.sleep):
    started = now()
    deadline = started + budget
    while now() < deadline:
        timeout = min(5.0, deadline - now())
        tick = now()
        outcome = 'completed'
        try:
            ready = probe(timeout)
        except subprocess.TimeoutExpired:
            ready = False
            outcome = 'command-timeout'
        records.append({'stage': name, 'ready': ready, 'outcome': outcome, 'elapsed': round(now()-tick, 3)})
        if ready:
            return
        sleep(min(1.0, max(0.0, deadline-now())))
    raise TimeoutError(f'{name} readiness deadline exhausted after {now()-started:.3f}s')


def safe_vertical_bounds(window_dump, width, height):
    """Use visible system-bar frames, never assume a navigation-bar height."""
    import re
    top, bottom = None, None
    for block in re.split(r'\n  Window #', window_dump):
        header = block.split('\n', 1)[0]
        if 'isVisible=true' not in block:
            continue
        frame = re.search(r'\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', block)
        if not frame:
            continue
        x1,y1,x2,y2 = map(int, frame.groups())
        if 'StatusBar}' in header and x1 == 0 and x2 == width and y1 == 0:
            top = y2
        if ('NavigationBar' in header or 'Taskbar}' in header) and x1 == 0 and x2 == width and y2 == height:
            bottom = y1
    if top is None or bottom is None or not 0 < top < bottom < height:
        raise RuntimeError('Cannot establish visible portrait system-bar frames')
    return top, bottom
