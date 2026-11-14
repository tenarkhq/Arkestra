import io, struct, os, shutil
from PIL import Image
big=Image.open('out/k-1024.png').convert('RGBA'); small=Image.open('out/k_s-1024.png').convert('RGBA')
def at(n): return (small if n<=32 else big).resize((n,n), Image.LANCZOS)
def png(im):
    b=io.BytesIO(); im.save(b,'PNG',optimize=True); return b.getvalue()
O='assets'; shutil.rmtree(O,ignore_errors=True)
for d in ['resources/darwin','resources/win32','resources/linux','src/vs/workbench/browser/media','src/vs/workbench/browser/parts/editor/media']:
    os.makedirs(f'{O}/{d}')
# macOS icns: PNG entries
icns=[(b'icp4',16),(b'icp5',32),(b'ic11',32),(b'icp6',64),(b'ic12',64),(b'ic07',128),(b'ic08',256),(b'ic13',256),(b'ic09',512),(b'ic14',512),(b'ic10',1024)]
body=b''
for t,n in icns:
    data=png(at(n)); body+=t+struct.pack('>I',len(data)+8)+data
open(f'{O}/resources/darwin/code.icns','wb').write(b'icns'+struct.pack('>I',len(body)+8)+body)
# Windows ico: PNG entries (Vista and newer)
sizes=[16,20,24,32,40,48,64,128,256]
imgs=[png(at(n)) for n in sizes]
hdr=struct.pack('<HHH',0,1,len(sizes)); off=6+16*len(sizes); dirs=b''
for n,d in zip(sizes,imgs):
    dirs+=struct.pack('<BBBBHHII',n%256,n%256,0,0,1,32,len(d),off); off+=len(d)
open(f'{O}/resources/win32/code.ico','wb').write(hdr+dirs+b''.join(imgs))
at(70).save(f'{O}/resources/win32/code_70x70.png'); at(150).save(f'{O}/resources/win32/code_150x150.png')
# Inno Setup wizard images (24-bit BMP): the big one on the plate's ink, the small one on white
def grad(w,h,top,bot):
    im=Image.new('RGB',(w,h))
    for y in range(h):
        t=y/max(1,h-1); im.paste(tuple(int(top[i]+(bot[i]-top[i])*t) for i in range(3)),(0,y,w,y+1))
    return im
V=os.path.join(os.path.dirname(os.path.abspath(__file__)),'../../vendor/vscodium/src/stable/resources/win32')
for pct in [100,125,150,175,200,225,250]:
    s=pct/100
    w,h=Image.open(f'{V}/inno-big-{pct}.bmp').size; bg=grad(w,h,(25,28,63),(7,8,26)); n=round(w*.72)
    bg.paste(at(n),((w-n)//2,round(h*.2)),at(n)); bg.save(f'{O}/resources/win32/inno-big-{pct}.bmp')
    w,h=Image.open(f'{V}/inno-small-{pct}.bmp').size; bg=Image.new('RGB',(w,h),(255,255,255)); n=round(min(w,h)*.88)
    bg.paste(at(n),((w-n)//2,(h-n)//2),at(n)); bg.save(f'{O}/resources/win32/inno-small-{pct}.bmp')
# Linux
big.save(f'{O}/resources/linux/code.png'); shutil.copy('k.svg',f'{O}/resources/linux/code.svg')
shutil.copy('k.svg',f'{O}/src/vs/workbench/browser/media/code-icon.svg')
# The empty editor's watermark: the gem as one colour, table cut free
A,L,R=(20,4),(3,35),(37,35); C=(20,24.5)
lerp=lambda p,q,t:(p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t)
tA,tL,tR=[lerp(p,C,.5) for p in (A,L,R)]; gA,gL,gR=[lerp(p,C,.42) for p in (A,L,R)]
P=lambda *ps:'M'+' L'.join(f'{x:.2f},{y:.2f}' for x,y in ps)+'Z'
for name,fill,op in [('dark','#B2B2B2','0.3'),('light','#B2B2B2','0.1'),('hcDark','#3C3C3C',None),('hcLight','#B2B2B2',None)]:
    o=f' fill-opacity="{op}"' if op else ''
    svg=(f'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><g fill="{fill}"{o}>'
         f'<path fill-rule="evenodd" d="{P(A,L,R)} {P(gA,gR,gL)}"/><path d="{P(tA,tL,tR)}"/></g></svg>')
    open(f'{O}/src/vs/workbench/browser/parts/editor/media/letterpress-{name}.svg','w').write(svg)
open(f'{O}/resources/win32/VisualElementsManifest.xml','w').write('''<Application xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<VisualElements
		BackgroundColor="#0D0F24"
		ShowNameOnSquare150x150Logo="on"
		Square150x150Logo="resources\\app\\resources\\win32\\code_150x150.png"
		Square70x70Logo="resources\\app\\resources\\win32\\code_70x70.png"
		ForegroundText="light"
		ShortDisplayName="Arkestra" />
</Application>
''')
print('ok')
# server (web) icons and favicon
os.makedirs(f'{O}/resources/server',exist_ok=True)
at(192).save(f'{O}/resources/server/code-192.png'); at(512).save(f'{O}/resources/server/code-512.png')
shutil.copy(f'{O}/resources/win32/code.ico',f'{O}/resources/server/favicon.ico')
# rpm XPM, 256 px, palette of up to 180 colours plus transparency
os.makedirs(f'{O}/resources/linux/rpm',exist_ok=True)
im=at(256); alpha=im.getchannel('A'); q=im.convert('RGB').quantize(180)
pal=q.getpalette()[:180*3]; px=q.load(); al=alpha.load()
chars='.#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+@$%&*=-;:>,<1'
code=lambda i:chars[i%len(chars)]+chars[i//len(chars)]
lines=['/* XPM */','static char *code[] = {',f'"256 256 181 2 ",','"   c None",']
lines+=[f'"{code(i)} c #{pal[3*i]:02X}{pal[3*i+1]:02X}{pal[3*i+2]:02X}",' for i in range(180)]
for y in range(256):
    lines.append('"'+''.join('  ' if al[x,y]<128 else code(px[x,y]) for x in range(256))+'",')
lines[-1]=lines[-1].rstrip(',')
open(f'{O}/resources/linux/rpm/code.xpm','w').write('\n'.join(lines)+'\n};\n')
print('extra ok')
