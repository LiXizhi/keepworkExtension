#!/usr/bin/env python3
"""Extract experiment-only sprites; requires curl, ffmpeg with libvpx-vp9, ffprobe.
No rights approval is created here. Raw source cache stays outside the repository.
"""
import urllib.parse
import argparse, concurrent.futures, hashlib, json, pathlib, struct, subprocess, tempfile, zlib
PIN = '72e804d87394fdb998244251a4e21bbb4fd3e932'
BASE = f'https://raw.githubusercontent.com/hodokoshitsunagu-arch/AINiangAssets/{PIN}/'
IDS = ['claude', 'gpt', 'gemini', 'grok', 'qwen', 'kimi', 'glm', 'minimax', 'deepseek']
NAMES = dict(zip(IDS, ['Claude', 'GPT', 'Gemini', 'Grok', 'Qwen', 'Kimi', 'GLM', 'MiniMax', 'DeepSeek']))
# Approximate experimental gestures, not semantic source annotations.
CLIPS = dict(idle='breath_release', happy='blow_kiss', listening='binoculars', thinking='balance_scale', speaking='air_quote', sleeping='breath_release', error='backstep')
DEEPSEEK_CLIPS = dict(idle='东张西望', happy='凭空生花', listening='东张西望', thinking='写代码', speaking='原地敲击桌面互动', sleeping='原地小憩沉眠', error='偷吃零食被抓住')
DSH_PIN = '31aa345b11a18fc16d5fd35c42b8b9441071170e'
DEEPSEEK_LICENSE = 'MIT License\n\nCopyright (c) 2026 PC2005-cloud\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n'
SIZE, FRAMES = 192, 16
# Host-reviewed source bytes, independent of newly generated provenance files.
CLAUDE_SOURCE_HASHES = {
    'breath_release': 'efc5acfc483fdc8d27070b16a551a4ffd2ec98259a881f6df5db02f43b9c6115',
    'blow_kiss': 'f44eae2c03942fe49a50cb8d881c597169dd1e5179b7f82f11cddf2f6012acc6',
    'binoculars': '1438020ce6cc82a1382ee76cf943c01347f45c74e0430b9d758e60ba743774b1',
    'balance_scale': 'bfd050987504c0b102d5ac2384980c66e8a4762f986ffac743af3adcf8896897',
    'air_quote': 'd0cd10c262b9483679a0d7d4f593b05a20ec08855dad10d3c7f1fcf1eb7e8868',
    'backstep': 'fec8eda4fda00ebff4de445556f40353bc3a109683abd217ed9e14627c3f15d7',
}


def run(args):
    return subprocess.check_output(args)

def png(path, width, height, rgba):
    def chunk(t, b):
        return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t+b))
    rows = b''.join(b'\0'+rgba[y*width*4:(y+1)*width*4] for y in range(height))
    data = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB',width,height,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(rows,9))+chunk(b'IEND',b'')
    assert len(data) <= 2*1024*1024
    path.write_bytes(data)
    return dict(path=path.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())

def native_png(path, width, height, rgba):
    # Preserve decoded RGBA exactly. PNG prediction reduces bytes without
    # quantization, sharpening, alpha cleanup or artificial upscaling.
    encoded = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'rawvideo',
        '-pixel_format', 'rgba', '-video_size', f'{width}x{height}', '-i', 'pipe:0',
        '-frames:v', '1', '-c:v', 'png', '-pred', 'mixed', '-compression_level', '9',
        '-f', 'image2pipe', 'pipe:1'], input=rgba, stdout=subprocess.PIPE, check=True).stdout
    assert encoded[:8] == b'\x89PNG\r\n\x1a\n'
    header = None; compressed = []; ended = False; offset = 8
    while offset < len(encoded):
        assert offset + 12 <= len(encoded), 'Truncated encoder PNG chunk'
        length = struct.unpack('>I', encoded[offset:offset+4])[0]
        kind = encoded[offset+4:offset+8]
        end = offset + length + 12
        assert end <= len(encoded) and not ended, 'Invalid encoder PNG bounds'
        data = encoded[offset+8:end-4]
        assert zlib.crc32(kind+data) == struct.unpack('>I', encoded[end-4:end])[0], 'Encoder PNG CRC mismatch'
        if kind == b'IHDR':
            assert offset == 8 and length == 13
            header = data
        elif kind == b'IDAT':
            assert header is not None
            compressed.append(data)
        elif kind == b'IEND':
            assert length == 0 and compressed and end == len(encoded)
            ended = True
        offset = end
    assert header is not None and ended
    def chunk(kind, data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
    # FFmpeg splits larger PNGs into many small IDAT chunks. Coalesce the
    # unchanged deflate stream to respect the admission limit of 64 chunks.
    clean = encoded[:8]+chunk(b'IHDR',header)+chunk(b'IDAT',b''.join(compressed))+chunk(b'IEND',b'')
    assert len(clean) <= 5*1024*1024//2
    path.write_bytes(clean)
    return dict(path=path.name, bytes=len(clean), sha256=hashlib.sha256(clean).hexdigest())


def build(character, output, cache):
    dest=output/character; dest.mkdir(parents=True,exist_ok=True)
    sources={}; decoded={}
    native = character == 'claude'
    width, height, columns = (640, 360, 4) if native else (SIZE, SIZE, FRAMES)
    encode = native_png if native else png
    clips = DEEPSEEK_CLIPS if character == 'deepseek' else CLIPS
    for clip in dict.fromkeys(clips.values()):
        source=f'videos/{character}/{clip}.webm'; local=cache/character/(clip+'.webm');local.parent.mkdir(parents=True,exist_ok=True)
        if not local.exists():
            tmp=local.with_suffix('.part')
            subprocess.run(['curl','--fail','--location','--retry','3','--silent','--show-error',BASE+urllib.parse.quote(source),'-o',str(tmp)],check=True);tmp.replace(local)
        if native:
            assert hashlib.sha256(local.read_bytes()).hexdigest() == CLAUDE_SOURCE_HASHES[clip], f'Unreviewed source bytes: {source}'
            info=json.loads(run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',str(local)]))['streams'][0]
            assert (info['width'],info['height']) == (width,height), f'Unexpected source dimensions: {source}'
        duration=float(json.loads(run(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(local)]))['format']['duration'])
        # Sample across whole clip into a four-second loop; scale and transparent pad.
        vf=f'fps={FRAMES/duration},scale={SIZE}:{SIZE}:force_original_aspect_ratio=decrease,format=rgba,pad={SIZE}:{SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0'
        if native:
            vf=f'fps={FRAMES/duration},format=rgba'
        raw=run(['ffmpeg','-v','error','-c:v','libvpx-vp9','-i',str(local),'-vf',vf,'-frames:v',str(FRAMES),'-f','rawvideo','-pix_fmt','rgba','pipe:1'])
        stride=width*height*4
        frames=[raw[i:i+stride] for i in range(0,len(raw),stride)]
        assert frames and all(len(f)==stride for f in frames)
        while len(frames)<FRAMES: frames.append(frames[-1])
        alpha=raw[3::4];assert min(alpha)==0 and max(alpha)>0, f'missing alpha: {source}'
        decoded[clip]=frames
        sources[clip]=dict(path=source,url=BASE+source,sha256=hashlib.sha256(local.read_bytes()).hexdigest(),bytes=local.stat().st_size,durationSeconds=duration,decodedAlphaMin=min(alpha),decodedAlphaMax=max(alpha))
        if native:
            sources[clip].update(width=width,height=height)
    if character == 'deepseek':
        for clip, record in sources.items():
            record['originalSourceUrl'] = f'https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/{DSH_PIN}/dsh-pet/assets/webm/' + urllib.parse.quote(clip+'.webm')
            record['originalSourceCommit'] = DSH_PIN
            record['attribution'] = 'Copyright (c) 2026 PC2005-cloud; MIT License; see DEEPSEEK-LICENSE.txt'
    poses={}
    for state,clip in clips.items():
        frames=decoded[clip]
        strip=b''.join(b''.join(f[y*width*4:(y+1)*width*4] for f in frames[row:row+columns]) for row in range(0,FRAMES,columns) for y in range(height))
        poses[state]=dict(file=encode(dest/(state+'.png'),width*columns,height*(FRAMES//columns),strip),frameCount=FRAMES,frameDurationMs=250)
        if native: poses[state]['columns']=columns
    poster=encode(dest/'poster.png',width,height,decoded[clips['idle']][0])
    manifest=dict(contractVersion='ai-pet.dev.v1',appearanceId='ainiang-'+character,appearanceVersion=('2' if native else '1'),characterId=character,characterVersion='1',provenance=dict(sourceRef=f'ainiangassets:{PIN}:{character}',licenseRef=('dsh-pet-mit-video-experiment' if character == 'deepseek' else 'experiment-user-attested-seedance-video-only'),rightsEvidenceRef='user-attestation-2026-11-17-ainiang-experiment'),width=width,height=height,anchor=dict(x=.5,y=1),poster=poster,poses=poses,mouthMode='prerecorded',labels={locale:NAMES[character] for locale in ['zh-CN','en-US','es-ES','ko-KR','ja-JP','fr-FR']})
    assert sum(p.stat().st_size for p in dest.glob('*.png'))<=(16 if native else 8)*1024*1024
    (dest/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    provenance=dict(commit=PIN,clips=sources,approximateStateMapping=clips,posterSource=dict(clip=clips['idle'],sampleIndex=0))
    if native:
        provenance['extraction']=dict(profile='desktop-native-grid-v1',width=width,height=height,columns=columns,rows=FRAMES//columns,frameCount=FRAMES,frameDurationMs=250,spatialProcessing='Native decoded RGBA; no spatial resize, padding, crop or enhancement',pngEncoding='FFmpeg PNG mixed prediction, compression level 9; only IHDR/IDAT/IEND',decoder='libvpx-vp9',ffmpegVersion=run(['ffmpeg','-version']).decode().splitlines()[0])
    (dest/'sources.json').write_text(json.dumps(provenance,indent=2)+'\n')
    print(character, 'ready',flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--characters', nargs='+', choices=IDS, default=IDS);parser.add_argument('--output',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parents[1]/'assets'/'ainiang');parser.add_argument('--cache',type=pathlib.Path,default=pathlib.Path(tempfile.gettempdir())/'keepwork-ainiang-source-cache'/PIN);args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'deepseek').mkdir(parents=True,exist_ok=True)
    (args.output/'deepseek'/'DEEPSEEK-LICENSE.txt').write_text(DEEPSEEK_LICENSE)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda c:build(c,args.output,args.cache),args.characters))
    catalog=dict(format='ainiang-experiment.v1',commit=PIN,experimentOnly=True,characters=[dict(id=c,name=NAMES[c],manifest=f'{c}/manifest.json') for c in IDS],disclosures=dict(rights='User attests the eight non-DeepSeek character videos were generated by them using Seedance and authorizes this experiment; separately instructs inclusion of DeepSeek dsh-pet videos with upstream MIT attribution. DeepSeek is not asserted to be user-generated. This is not legal adjudication or production entitlement; host-side independent approval is required.',excluded='All upstream portraits excluded. Nine characters use video-derived posters.',animation='Approximate state mappings; speaking is prerecorded, without mouth layers or true lip-sync.',processing='Technical extraction only: whole-clip temporal resampling to 16 frames, 250ms/frame; poster uses first idle sample. Claude uses native 640x360 RGBA frames in a 4x4 grid; the other eight characters retain aspect-preserving 192px transparent padding and horizontal strips.'))
    (args.output/'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':main()
